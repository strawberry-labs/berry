#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::path::{Path, PathBuf};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime, UNIX_EPOCH};
use tauri::{webview::PageLoadEvent, AppHandle, Emitter, Manager, State};
use tauri_plugin_dialog::DialogExt;
use tauri_plugin_updater::UpdaterExt;

const HOST_EVENT_NAME: &str = "berry://host-event";
const REQUEST_TIMEOUT: Duration = Duration::from_secs(120);
const HANDSHAKE_TIMEOUT: Duration = Duration::from_secs(10);
const INLINE_IMAGE_BYTES: u64 = 4 * 1024 * 1024;

enum ManagedPolicyLoad {
    Absent { path: PathBuf },
    Active { path: PathBuf, bytes: Vec<u8> },
    Rejected { path: PathBuf, error: String },
}

fn managed_policy_path() -> PathBuf {
    if let Some(path) = std::env::var_os("BERRY_MANAGED_POLICY_PATH") {
        return PathBuf::from(path);
    }
    #[cfg(target_os = "macos")]
    return PathBuf::from("/Library/Managed Preferences/com.berry.chat/berry-policy.json");
    #[cfg(target_os = "windows")]
    return std::env::var_os("PROGRAMDATA")
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(r"C:\ProgramData"))
        .join("Berry")
        .join("berry-policy.json");
    #[cfg(all(not(target_os = "macos"), not(target_os = "windows")))]
    PathBuf::from("/etc/berry/berry-policy.json")
}

fn managed_policy_public_key(path: &Path) -> Result<String, String> {
    if let Ok(value) = std::env::var("BERRY_MANAGED_POLICY_PUBLIC_KEY") {
        if !value.trim().is_empty() {
            return Ok(value.trim().to_string());
        }
    }
    let key_path = PathBuf::from(format!("{}.pub", path.display()));
    fs::read_to_string(&key_path)
        .map(|value| value.trim().to_string())
        .map_err(|error| format!("managed policy public key is unavailable at {}: {error}", key_path.display()))
}

fn decode_policy_base64(value: &str) -> Result<Vec<u8>, String> {
    use base64::Engine;
    base64::engine::general_purpose::STANDARD
        .decode(value)
        .or_else(|_| base64::engine::general_purpose::STANDARD_NO_PAD.decode(value))
        .or_else(|_| base64::engine::general_purpose::URL_SAFE_NO_PAD.decode(value))
        .map_err(|error| format!("invalid base64: {error}"))
}

fn canonical_policy_json(value: &Value) -> String {
    match value {
        Value::Null => "null".to_string(),
        Value::Bool(value) => value.to_string(),
        Value::Number(value) => value.to_string(),
        Value::String(value) => serde_json::to_string(value).unwrap_or_else(|_| "\"\"".to_string()),
        Value::Array(values) => format!("[{}]", values.iter().map(canonical_policy_json).collect::<Vec<_>>().join(",")),
        Value::Object(values) => {
            let mut entries = values.iter().collect::<Vec<_>>();
            entries.sort_by(|(left, _), (right, _)| left.cmp(right));
            format!(
                "{{{}}}",
                entries
                    .into_iter()
                    .map(|(key, value)| format!("{}:{}", serde_json::to_string(key).unwrap_or_else(|_| "\"\"".to_string()), canonical_policy_json(value)))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
    }
}

fn verify_managed_policy_bytes(bytes: &[u8], public_key: &str) -> Result<(), String> {
    use ed25519_dalek::{Signature, VerifyingKey};
    let mut value: Value = serde_json::from_slice(bytes).map_err(|error| format!("invalid managed policy JSON: {error}"))?;
    let object = value.as_object_mut().ok_or("managed policy must be an object")?;
    let signature = object.remove("signature").ok_or("managed policy signature is missing")?;
    let signature_object = signature.as_object().ok_or("managed policy signature must be an object")?;
    if signature_object.get("algorithm").and_then(Value::as_str) != Some("ed25519") {
        return Err("managed policy signature algorithm must be ed25519".to_string());
    }
    let signature_value = signature_object.get("value").and_then(Value::as_str).ok_or("managed policy signature value is missing")?;
    let public_key_bytes = decode_policy_base64(public_key)?;
    let public_key_array: [u8; 32] = public_key_bytes.try_into().map_err(|_| "managed policy public key must contain 32 bytes")?;
    let verifying_key = VerifyingKey::from_bytes(&public_key_array).map_err(|error| format!("invalid managed policy public key: {error}"))?;
    let signature_bytes = decode_policy_base64(signature_value)?;
    let signature = Signature::from_slice(&signature_bytes).map_err(|error| format!("invalid managed policy signature: {error}"))?;
    verifying_key
        .verify_strict(canonical_policy_json(&value).as_bytes(), &signature)
        .map_err(|_| "managed policy signature verification failed".to_string())
}

fn load_managed_policy() -> ManagedPolicyLoad {
    let path = managed_policy_path();
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return ManagedPolicyLoad::Absent { path },
        Err(error) => return ManagedPolicyLoad::Rejected { path, error: format!("managed policy cannot be read: {error}") },
    };
    let result = managed_policy_public_key(&path).and_then(|key| verify_managed_policy_bytes(&bytes, &key));
    match result {
        Ok(()) => ManagedPolicyLoad::Active { path, bytes },
        Err(error) => ManagedPolicyLoad::Rejected { path, error },
    }
}

/// Shared with the stdout reader thread: request routing and liveness.
struct HostChannel {
    stdin: Mutex<ChildStdin>,
    pending: Mutex<HashMap<String, mpsc::Sender<Value>>>,
    alive: AtomicBool,
}

impl HostChannel {
    fn fail_all(&self) {
        if let Ok(mut pending) = self.pending.lock() {
            // Dropping the senders makes every waiting receiver fail with Disconnected.
            pending.clear();
        }
    }
}

struct HostProcess {
    child: Child,
    channel: Arc<HostChannel>,
    next_id: u64,
}

struct HostState {
    nonce: String,
    process: Mutex<Option<HostProcess>>,
    credential_cache: Mutex<HashMap<String, String>>,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct PickedFile {
    path: String,
    name: String,
    media_type: String,
    size: u64,
    data_url: Option<String>,
}

#[tauri::command]
async fn host_rpc(
    app: AppHandle,
    state: State<'_, HostState>,
    method: String,
    params: Option<Value>,
) -> Result<Value, String> {
    if method == "updater.status" {
        return updater_status(app).await;
    }
    if method == "updater.install" {
        return updater_install(app).await;
    }
    let params = inject_credentials(state.inner(), &method, params)?;
    let (channel, receiver, id) = prepare_request(&app, state.inner(), &method, params)?;
    let outcome =
        tauri::async_runtime::spawn_blocking(move || receiver.recv_timeout(REQUEST_TIMEOUT))
            .await
            .map_err(|error| format!("host rpc join error: {error}"))?;
    match outcome {
        Ok(response) => decode_response(response),
        Err(RecvTimeoutError::Timeout) => {
            if let Ok(mut pending) = channel.pending.lock() {
                pending.remove(&id);
            }
            Err(format!("berry-host request timed out: {method}"))
        }
        Err(RecvTimeoutError::Disconnected) => {
            Err(format!("berry-host exited before responding to {method}"))
        }
    }
}

fn updater_endpoint_from_env() -> Option<String> {
    std::env::var("BERRY_UPDATER_ENDPOINT")
        .or_else(|_| std::env::var("TAURI_UPDATER_ENDPOINT"))
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn updater_public_key_from_env() -> Option<String> {
    std::env::var("BERRY_UPDATER_PUBLIC_KEY")
        .or_else(|_| std::env::var("TAURI_UPDATER_PUBKEY"))
        .or_else(|_| std::env::var("TAURI_SIGNING_PUBLIC_KEY"))
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

async fn check_signed_update(
    app: &AppHandle,
) -> Result<Option<tauri_plugin_updater::Update>, String> {
    let endpoint = updater_endpoint_from_env();
    let public_key = updater_public_key_from_env();
    if let (Some(endpoint), Some(public_key)) = (endpoint.as_ref(), public_key.as_ref()) {
        let endpoint = endpoint
            .parse()
            .map_err(|error| format!("invalid updater endpoint: {error}"))?;
        return app
            .updater_builder()
            .endpoints(vec![endpoint])
            .map_err(|error| error.to_string())?
            .pubkey(public_key.to_string())
            .build()
            .map_err(|error| error.to_string())?
            .check()
            .await
            .map_err(|error| error.to_string());
    }
    app.updater()
        .map_err(|error| error.to_string())?
        .check()
        .await
        .map_err(|error| error.to_string())
}

async fn updater_status(app: AppHandle) -> Result<Value, String> {
    let endpoint = updater_endpoint_from_env();
    let signing_key_present = updater_public_key_from_env().is_some();
    let feed = endpoint.as_deref().unwrap_or("github-releases");
    match check_signed_update(&app).await {
        Ok(Some(update)) => Ok(json!({
            "status": "available",
            "feed": feed,
            "configured": true,
            "endpoint": endpoint,
            "signingKeyPresent": true,
            "currentVersion": update.current_version,
            "version": update.version,
            "date": update.date.map(|date| date.to_string()),
            "body": update.body,
            "rolloutEligible": true,
        })),
        Ok(None) => Ok(json!({
            "status": "current",
            "feed": feed,
            "configured": true,
            "endpoint": endpoint,
            "signingKeyPresent": true,
            "currentVersion": env!("CARGO_PKG_VERSION"),
            "rolloutEligible": true,
        })),
        Err(error) => {
            let configured = endpoint.is_some() && signing_key_present;
            Ok(json!({
                "status": if configured { "error" } else { "not-configured" },
                "feed": feed,
                "configured": configured,
                "endpoint": endpoint,
                "signingKeyPresent": signing_key_present,
                "currentVersion": env!("CARGO_PKG_VERSION"),
                "rolloutEligible": false,
                "error": error,
            }))
        }
    }
}

async fn updater_install(app: AppHandle) -> Result<Value, String> {
    let update = match check_signed_update(&app).await {
        Ok(Some(update)) => update,
        Ok(None) => {
            return Ok(json!({
                "installed": false,
                "status": "current",
                "restartRequired": false,
            }))
        }
        Err(error) => {
            return Ok(json!({
                "installed": false,
                "status": "error",
                "restartRequired": false,
                "error": error,
            }))
        }
    };
    let version = update.version.clone();
    update
        .download_and_install(|_, _| {}, || {})
        .await
        .map_err(|error| error.to_string())?;
    Ok(json!({
        "installed": true,
        "status": "installed",
        "version": version,
        "restartRequired": true,
    }))
}

/* ------------------------------------------------------------------------ */
/* Credential store for encrypted desktop secret references.                 */
/*                                                                            */
/* Secrets live in `credentials.json` inside the Berry data dir as a flat    */
/* { reference: ciphertext } map. Each value is AES-256-GCM encrypted and    */
/* serialized as `enc:v1:<iv>.<authTag>.<ciphertext>` (base64url, no pad).   */
/* The cipher key is SHA-256 of BERRY_CREDENTIAL_SECRET, falling back to a   */
/* machine-derived string (platform:hostname:username). Values that don't    */
/* start with the prefix decrypt as-is (plaintext migration passthrough).    */
/* No OS keychain is ever touched, so opening the app never prompts.         */
/* ------------------------------------------------------------------------ */

const CREDENTIAL_ENC_PREFIX: &str = "enc:v1:";
const CREDENTIAL_SECRET_ENV: &str = "BERRY_CREDENTIAL_SECRET";
const GCM_TAG_LEN: usize = 16;

fn credentials_dir() -> std::path::PathBuf {
    let home = std::env::var("HOME").unwrap_or_default();
    if cfg!(target_os = "macos") {
        Path::new(&home).join("Library/Application Support/Berry")
    } else if cfg!(windows) {
        std::env::var("APPDATA")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|_| {
                Path::new(&std::env::var("USERPROFILE").unwrap_or_default()).join("AppData/Roaming")
            })
            .join("Berry")
    } else {
        std::env::var("XDG_DATA_HOME")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(|_| Path::new(&home).join(".local/share"))
            .join("Berry")
    }
}

fn credentials_file() -> std::path::PathBuf {
    credentials_dir().join("credentials.json")
}

/// Derive the local credential key from the configured secret and host data.
fn credential_cipher_key() -> [u8; 32] {
    use sha2::{Digest, Sha256};
    let secret = std::env::var(CREDENTIAL_SECRET_ENV).unwrap_or_else(|_| {
        let hostname = gethostname::gethostname().to_string_lossy().to_string();
        let username = std::env::var("USER")
            .or_else(|_| std::env::var("USERNAME"))
            .unwrap_or_else(|_| "unknown".to_string());
        format!(
            "berry-credential-fallback:{}:{}:{}",
            std::env::consts::OS,
            hostname,
            username
        )
    });
    Sha256::digest(secret.as_bytes()).into()
}

fn b64() -> base64::engine::general_purpose::GeneralPurpose {
    base64::engine::general_purpose::URL_SAFE_NO_PAD
}

fn encrypt_credential(plain: &str) -> Result<String, String> {
    use aes_gcm::aead::{Aead, AeadCore, KeyInit, OsRng};
    use aes_gcm::Aes256Gcm;
    use base64::Engine;
    let cipher = Aes256Gcm::new_from_slice(&credential_cipher_key())
        .map_err(|error| format!("failed to initialize credential cipher: {error}"))?;
    let nonce = Aes256Gcm::generate_nonce(&mut OsRng);
    let sealed = cipher
        .encrypt(&nonce, plain.as_bytes())
        .map_err(|error| format!("failed to encrypt credential: {error}"))?;
    // RustCrypto appends the auth tag; Berry's persisted envelope stores it separately.
    let (ciphertext, tag) = sealed.split_at(sealed.len() - GCM_TAG_LEN);
    Ok(format!(
        "{CREDENTIAL_ENC_PREFIX}{}.{}.{}",
        b64().encode(nonce),
        b64().encode(tag),
        b64().encode(ciphertext)
    ))
}

fn decrypt_credential(value: &str) -> Result<String, String> {
    use aes_gcm::aead::{Aead, KeyInit};
    use aes_gcm::Aes256Gcm;
    use base64::Engine;
    // Legacy passthrough: values without the prefix are returned verbatim.
    let Some(encoded) = value.strip_prefix(CREDENTIAL_ENC_PREFIX) else {
        return Ok(value.to_string());
    };
    let parts: Vec<&str> = encoded.split('.').collect();
    let [iv, tag, ciphertext] = parts.as_slice() else {
        return Err("credential decrypt failed: malformed ciphertext".to_string());
    };
    let iv = b64()
        .decode(iv)
        .map_err(|_| "credential decrypt failed: bad iv".to_string())?;
    let tag = b64()
        .decode(tag)
        .map_err(|_| "credential decrypt failed: bad auth tag".to_string())?;
    let ciphertext = b64()
        .decode(ciphertext)
        .map_err(|_| "credential decrypt failed: bad ciphertext".to_string())?;
    if iv.len() != 12 || tag.len() != GCM_TAG_LEN {
        return Err("credential decrypt failed: bad iv/tag length".to_string());
    }
    let cipher = Aes256Gcm::new_from_slice(&credential_cipher_key())
        .map_err(|error| format!("failed to initialize credential cipher: {error}"))?;
    let mut sealed = ciphertext;
    sealed.extend_from_slice(&tag);
    let plain = cipher
        .decrypt(aes_gcm::Nonce::from_slice(&iv), sealed.as_slice())
        .map_err(|_| "credential decrypt failed: key mismatch or corrupt data".to_string())?;
    String::from_utf8(plain).map_err(|_| "credential decrypt failed: invalid utf-8".to_string())
}

fn read_credential_store() -> HashMap<String, String> {
    let Ok(content) = fs::read_to_string(credentials_file()) else {
        return HashMap::new();
    };
    serde_json::from_str::<HashMap<String, String>>(&content).unwrap_or_default()
}

fn write_credential_store(store: &HashMap<String, String>) -> Result<(), String> {
    fs::create_dir_all(credentials_dir())
        .map_err(|error| format!("failed to create credential dir: {error}"))?;
    let content = serde_json::to_string_pretty(store)
        .map_err(|error| format!("failed to serialize credentials: {error}"))?;
    fs::write(credentials_file(), content)
        .map_err(|error| format!("failed to write credentials: {error}"))
}

#[tauri::command]
fn credential_set(
    state: State<'_, HostState>,
    reference: String,
    secret: String,
) -> Result<(), String> {
    let mut store = read_credential_store();
    store.insert(reference.clone(), encrypt_credential(&secret)?);
    write_credential_store(&store)?;
    if let Ok(mut cache) = state.credential_cache.lock() {
        cache.insert(reference, secret);
    }
    Ok(())
}

fn credential_get_uncached(reference: &str) -> Result<Option<String>, String> {
    match read_credential_store().get(reference) {
        Some(value) => decrypt_credential(value).map(Some),
        None => Ok(None),
    }
}

#[tauri::command]
fn credential_status(state: State<'_, HostState>, reference: String) -> Result<Value, String> {
    let secret = credential_get_cached(state.inner(), &reference)?;
    Ok(match secret {
        Some(secret) => json!({
            "exists": true,
            "hint": credential_hint(&secret),
            "storage": "encrypted-file",
            "plaintext": false,
        }),
        None => json!({
            "exists": false,
            "hint": null,
            "storage": "encrypted-file",
            "plaintext": false,
        }),
    })
}

#[tauri::command]
fn credential_delete(state: State<'_, HostState>, reference: String) -> Result<(), String> {
    let mut store = read_credential_store();
    if store.remove(&reference).is_some() {
        write_credential_store(&store)?;
    }
    if let Ok(mut cache) = state.credential_cache.lock() {
        cache.remove(&reference);
    }
    Ok(())
}

fn credential_get_cached(state: &HostState, reference: &str) -> Result<Option<String>, String> {
    if let Ok(cache) = state.credential_cache.lock() {
        if let Some(secret) = cache.get(reference) {
            return Ok(Some(secret.clone()));
        }
    }
    let secret = credential_get_uncached(reference)?;
    if let Some(secret_value) = secret.as_ref() {
        if let Ok(mut cache) = state.credential_cache.lock() {
            cache.insert(reference.to_string(), secret_value.clone());
        }
    }
    Ok(secret)
}

fn credential_hint(secret: &str) -> String {
    let trimmed = secret.trim();
    let suffix: String = trimmed
        .chars()
        .rev()
        .filter(|ch| !ch.is_whitespace())
        .take(4)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect();
    if suffix.is_empty() {
        "••••".to_string()
    } else {
        format!("••••{suffix}")
    }
}

/// Ensure a live host process (respawning lazily after a crash), then write
/// one request frame and return the response channel for it.
fn prepare_request(
    app: &AppHandle,
    state: &HostState,
    method: &str,
    params: Option<Value>,
) -> Result<(Arc<HostChannel>, mpsc::Receiver<Value>, String), String> {
    let mut guard = state
        .process
        .lock()
        .map_err(|_| "host process lock poisoned".to_string())?;

    if let Some(process) = guard.as_mut() {
        let exited = process
            .child
            .try_wait()
            .map_err(|error| error.to_string())?
            .is_some();
        if exited || !process.channel.alive.load(Ordering::SeqCst) {
            process.channel.fail_all();
            *guard = None;
        }
    }

    if guard.is_none() {
        let mut process = spawn_host(app.clone(), &state.nonce)?;
        let (_, handshake_rx, _) = register_and_write(
            &mut process,
            "host.handshake",
            Some(json!({ "nonce": state.nonce, "protocolVersion": 1 })),
        )?;
        match handshake_rx.recv_timeout(HANDSHAKE_TIMEOUT) {
            Ok(response) => {
                decode_response(response)?;
            }
            Err(_) => return Err("berry-host handshake timed out".to_string()),
        }
        *guard = Some(process);
    }

    let process = guard
        .as_mut()
        .ok_or_else(|| "host process unavailable".to_string())?;
    register_and_write(process, method, params)
}

fn register_and_write(
    process: &mut HostProcess,
    method: &str,
    params: Option<Value>,
) -> Result<(Arc<HostChannel>, mpsc::Receiver<Value>, String), String> {
    let id = process.next_id.to_string();
    process.next_id += 1;
    let frame = match params {
        Some(params) => json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }),
        None => json!({ "jsonrpc": "2.0", "id": id, "method": method }),
    };

    let (sender, receiver) = mpsc::channel();
    process
        .channel
        .pending
        .lock()
        .map_err(|_| "host pending lock poisoned".to_string())?
        .insert(id.clone(), sender);

    let write_result = {
        let mut stdin = process
            .channel
            .stdin
            .lock()
            .map_err(|_| "host stdin lock poisoned".to_string())?;
        writeln!(stdin, "{frame}").and_then(|_| stdin.flush())
    };
    if let Err(error) = write_result {
        if let Ok(mut pending) = process.channel.pending.lock() {
            pending.remove(&id);
        }
        process.channel.alive.store(false, Ordering::SeqCst);
        return Err(format!("failed to write to berry-host: {error}"));
    }

    Ok((process.channel.clone(), receiver, id))
}

fn warm_provider_credentials(app: &AppHandle, state: &HostState) -> Result<(), String> {
    let (channel, receiver, id) = prepare_request(app, state, "model.provider.list", None)?;
    let response = match receiver.recv_timeout(Duration::from_secs(15)) {
        Ok(response) => response,
        Err(RecvTimeoutError::Timeout) => {
            if let Ok(mut pending) = channel.pending.lock() {
                pending.remove(&id);
            }
            return Err("model provider warmup timed out".to_string());
        }
        Err(RecvTimeoutError::Disconnected) => {
            return Err("berry-host exited during credential warmup".to_string())
        }
    };
    let providers = decode_response(response)?;
    let mut references = HashSet::new();
    if let Value::Array(items) = providers {
        for item in items {
            if let Some(reference) = item.get("credentialRef").and_then(Value::as_str) {
                if !reference.is_empty() {
                    references.insert(reference.to_string());
                }
            }
        }
    }
    for reference in references {
        let _ = credential_get_cached(state, &reference);
    }
    Ok(())
}

fn decode_response(response: Value) -> Result<Value, String> {
    if let Some(error) = response.get("error") {
        let message = error
            .get("message")
            .and_then(Value::as_str)
            .unwrap_or("berry-host request failed");
        let code = error.get("code").and_then(Value::as_str).unwrap_or("error");
        return Err(json!({
            "code": code,
            "message": message,
            "details": error.get("details").cloned().unwrap_or(Value::Null)
        })
        .to_string());
    }
    Ok(response.get("result").cloned().unwrap_or(Value::Null))
}

fn spawn_host(app: AppHandle, nonce: &str) -> Result<HostProcess, String> {
    let mut command = if let Ok(entry) = std::env::var("BERRY_HOST_NODE_ENTRY") {
        let mut command =
            Command::new(std::env::var("BERRY_HOST_NODE").unwrap_or_else(|_| "node".to_string()));
        command.arg(entry);
        command
    } else if let Some(entry) = development_host_entry() {
        let mut command =
            Command::new(std::env::var("BERRY_HOST_NODE").unwrap_or_else(|_| "node".to_string()));
        command.arg(entry);
        command
    } else if let Some(bundled) = bundled_sidecar("berry-host") {
        Command::new(bundled)
    } else {
        Command::new(std::env::var("BERRY_HOST_BIN").unwrap_or_else(|_| "berry-host".to_string()))
    };

    if std::env::var("BERRY_PTY_BIN").is_err() {
        if let Some(pty) = bundled_sidecar("berry-pty") {
            command.env("BERRY_PTY_BIN", pty);
        }
    }
    if std::env::var("BERRY_BROWSER_CLI").is_err() {
        if let Some(browser) = bundled_sidecar("agent-browser") {
            command.env("BERRY_BROWSER_CLI", browser);
        }
    }

    for (key, value) in desktop_env_vars() {
        if std::env::var_os(&key).is_none() {
            command.env(key, value);
        }
    }

    command
        .env_remove("BERRY_VERIFIED_POLICY_BASE64")
        .env_remove("BERRY_MANAGED_POLICY_ERROR")
        .env_remove("BERRY_MANAGED_POLICY_RESOLVED_PATH");
    match load_managed_policy() {
        ManagedPolicyLoad::Absent { path } => {
            command.env("BERRY_MANAGED_POLICY_RESOLVED_PATH", path);
        }
        ManagedPolicyLoad::Active { path, bytes } => {
            use base64::Engine;
            command
                .env("BERRY_MANAGED_POLICY_RESOLVED_PATH", path)
                .env("BERRY_VERIFIED_POLICY_BASE64", base64::engine::general_purpose::STANDARD.encode(bytes));
        }
        ManagedPolicyLoad::Rejected { path, error } => {
            command
                .env("BERRY_MANAGED_POLICY_RESOLVED_PATH", path)
                .env("BERRY_MANAGED_POLICY_ERROR", error);
        }
    }

    if std::env::var_os("BERRY_HOST_SOCKET").is_none() {
        let runtime_dir = std::env::var_os("XDG_RUNTIME_DIR")
            .map(std::path::PathBuf::from)
            .unwrap_or_else(std::env::temp_dir);
        command.env("BERRY_HOST_SOCKET", runtime_dir.join("berry").join("host.sock"));
    }

    let mut child = command
        .env("BERRY_HOST_NONCE", nonce)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::inherit())
        .spawn()
        .map_err(|error| format!("failed to spawn berry-host: {error}"))?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "host stdin unavailable".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "host stdout unavailable".to_string())?;

    let channel = Arc::new(HostChannel {
        stdin: Mutex::new(stdin),
        pending: Mutex::new(HashMap::new()),
        alive: AtomicBool::new(true),
    });

    let reader_channel = Arc::clone(&channel);
    std::thread::spawn(move || {
        let mut reader = BufReader::new(stdout);
        let mut line = String::new();
        loop {
            line.clear();
            match reader.read_line(&mut line) {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
            let trimmed = line.trim();
            if trimmed.is_empty() {
                continue;
            }
            let Ok(value) = serde_json::from_str::<Value>(trimmed) else {
                continue;
            };
            if let Some(id) = value.get("id").and_then(Value::as_str).map(str::to_string) {
                if let Ok(mut pending) = reader_channel.pending.lock() {
                    if let Some(sender) = pending.remove(&id) {
                        let _ = sender.send(value);
                    }
                }
                continue;
            }
            if value.get("method").and_then(Value::as_str) == Some("host.event") {
                let payload = value.get("params").cloned().unwrap_or(Value::Null);
                let _ = app.emit(HOST_EVENT_NAME, payload);
            }
        }
        reader_channel.alive.store(false, Ordering::SeqCst);
        reader_channel.fail_all();
    });

    Ok(HostProcess {
        child,
        channel,
        next_id: 1,
    })
}

fn development_host_entry() -> Option<String> {
    let entry = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../../packages/host/dist/main.js");
    if entry.exists() {
        Some(entry.to_string_lossy().to_string())
    } else {
        None
    }
}

fn desktop_env_vars() -> Vec<(String, String)> {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("../.env");
    parse_env_file(&path).unwrap_or_default()
}

fn parse_env_file(path: &Path) -> Result<Vec<(String, String)>, String> {
    let content = match fs::read_to_string(path) {
        Ok(content) => content,
        Err(_) => return Ok(Vec::new()),
    };
    let mut output = Vec::new();
    for raw_line in content.lines() {
        let line = raw_line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line.strip_prefix("export ").unwrap_or(line).trim();
        let Some((raw_key, raw_value)) = line.split_once('=') else {
            continue;
        };
        let key = raw_key.trim();
        if key.is_empty()
            || !key
                .chars()
                .all(|ch| ch == '_' || ch.is_ascii_alphanumeric())
        {
            continue;
        }
        if !key.starts_with("FIREWORKS_") && !key.starts_with("BERRY_") {
            continue;
        }
        let mut value = raw_value.trim().to_string();
        if value.len() >= 2 {
            let first = value.as_bytes()[0] as char;
            let last = value.as_bytes()[value.len() - 1] as char;
            if (first == '"' && last == '"') || (first == '\'' && last == '\'') {
                value = value[1..value.len() - 1].to_string();
            }
        }
        output.push((key.to_string(), value));
    }
    Ok(output)
}

/// The renderer identifies providers by their public `credentialRef`; only this
/// shell reads the encrypted credential file. Automatic turn/model requests
/// read through the shell cache, falling back to the file on a miss, so the
/// plaintext key is never exposed to the webview.
fn inject_credentials(
    state: &HostState,
    method: &str,
    params: Option<Value>,
) -> Result<Option<Value>, String> {
    if method != "agent.turn"
        && method != "session.compact"
        && method != "review.start"
        && method != "git.pr.draft"
        && method != "model.provider.models"
        && method != "router.account.get"
        && method != "mcp.server.health"
        && method != "mcp.server.reconnect"
    {
        return Ok(params);
    }
    match params {
        Some(Value::Object(mut object)) => {
            let has_key = object
                .get("apiKey")
                .map(|value| !value.is_null())
                .unwrap_or(false);
            if !has_key {
                if let Some(Value::String(reference)) = object.get("credentialRef") {
                    match credential_get_cached(state, reference) {
                        Ok(Some(secret)) => {
                            object.insert("apiKey".to_string(), Value::String(secret));
                        }
                        Ok(None) | Err(_) => {}
                    }
                }
            }
            if method == "agent.turn" {
                let has_web_key = object
                    .get("webSearchApiKey")
                    .map(|value| !value.is_null())
                    .unwrap_or(false);
                if !has_web_key {
                    if let Some(Value::String(reference)) = object.get("webSearchCredentialRef") {
                        match credential_get_cached(state, reference) {
                            Ok(Some(secret)) => {
                                object.insert("webSearchApiKey".to_string(), Value::String(secret));
                            }
                            Ok(None) | Err(_) => {}
                        }
                    }
                }
                if !object.contains_key("mcpCredentials") {
                    if let Some(Value::Array(references)) = object.get("mcpCredentialRefs") {
                        let mut credentials = serde_json::Map::new();
                        for value in references {
                            if let Value::String(reference) = value {
                                if let Ok(Some(secret)) = credential_get_cached(state, reference) {
                                    credentials.insert(reference.clone(), Value::String(secret));
                                }
                            }
                        }
                        object.insert("mcpCredentials".to_string(), Value::Object(credentials));
                    }
                }
            }
            if method == "mcp.server.health" || method == "mcp.server.reconnect" {
                if let Some(Value::String(reference)) = object.get("credentialRef") {
                    if let Ok(Some(secret)) = credential_get_cached(state, reference) {
                        object.insert("mcpCredential".to_string(), Value::String(secret));
                    }
                }
            }
            Ok(Some(Value::Object(object)))
        }
        other => Ok(other),
    }
}

/// Tauri drops `bundle.externalBin` sidecars next to the app executable with
/// the target triple stripped, so production resolution is exe-adjacent.
fn bundled_sidecar(name: &str) -> Option<std::path::PathBuf> {
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let file = if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.to_string()
    };
    let candidate = dir.join(file);
    if candidate.exists() {
        Some(candidate)
    } else {
        None
    }
}

fn nonce() -> String {
    let nanos = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_nanos())
        .unwrap_or_default();
    format!("berry-{nanos}")
}

/// Opens the native OS folder picker and returns the chosen directory path,
/// or `None` if the user cancelled. Used by the workspace switcher's
/// "Open folder" action; the renderer falls back to manual path entry when
/// this command is unavailable (e.g. running in a plain browser during dev).
#[tauri::command]
async fn pick_directory(app: AppHandle) -> Result<Option<String>, String> {
    let (tx, rx) = mpsc::channel();
    app.dialog().file().pick_folder(move |path| {
        let _ = tx.send(path);
    });
    let picked = tauri::async_runtime::spawn_blocking(move || rx.recv())
        .await
        .map_err(|error| format!("folder picker join error: {error}"))?
        .map_err(|error| format!("folder picker closed unexpectedly: {error}"))?;
    Ok(picked.map(|path| path.to_string()))
}

/// Opens the native OS file picker and returns selected file metadata,
/// including absolute paths for path-backed prompt attachments.
#[tauri::command]
async fn pick_files(app: AppHandle) -> Result<Vec<PickedFile>, String> {
    let (tx, rx) = mpsc::channel();
    app.dialog().file().pick_files(move |paths| {
        let _ = tx.send(paths);
    });
    let picked = tauri::async_runtime::spawn_blocking(move || rx.recv())
        .await
        .map_err(|error| format!("file picker join error: {error}"))?
        .map_err(|error| format!("file picker closed unexpectedly: {error}"))?;
    let Some(paths) = picked else {
        return Ok(Vec::new());
    };
    Ok(paths
        .into_iter()
        .map(|path| picked_file(path.to_string()))
        .collect())
}

/// Opens a native file picker restricted to Agent Skills transport packages.
#[tauri::command]
async fn pick_skill_file(app: AppHandle) -> Result<Option<String>, String> {
    let (tx, rx) = mpsc::channel();
    app.dialog()
        .file()
        .add_filter("Agent Skill", &["skill"])
        .pick_file(move |path| {
            let _ = tx.send(path);
        });
    let picked = tauri::async_runtime::spawn_blocking(move || rx.recv())
        .await
        .map_err(|error| format!("skill picker join error: {error}"))?
        .map_err(|error| format!("skill picker closed unexpectedly: {error}"))?;
    Ok(picked.map(|path| path.to_string()))
}

fn picked_file(path: String) -> PickedFile {
    let fs_path = Path::new(&path);
    let name = fs_path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or("attachment")
        .to_string();
    let size = fs::metadata(fs_path)
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    let media_type = infer_media_type(&name).to_string();
    let data_url = picked_file_data_url(fs_path, &media_type, size);
    PickedFile {
        path,
        media_type,
        name,
        size,
        data_url,
    }
}

fn picked_file_data_url(path: &Path, media_type: &str, size: u64) -> Option<String> {
    if !media_type.starts_with("image/") || size > INLINE_IMAGE_BYTES {
        return None;
    }
    let bytes = fs::read(path).ok()?;
    use base64::Engine;
    Some(format!(
        "data:{media_type};base64,{}",
        base64::engine::general_purpose::STANDARD.encode(bytes)
    ))
}

fn infer_media_type(name: &str) -> &'static str {
    let extension = Path::new(name)
        .extension()
        .and_then(|value| value.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    match extension.as_str() {
        "md" => "text/markdown",
        "json" => "application/json",
        "csv" => "text/csv",
        "txt" | "log" => "text/plain",
        "png" => "image/png",
        "jpg" | "jpeg" => "image/jpeg",
        "gif" => "image/gif",
        "webp" => "image/webp",
        "svg" => "image/svg+xml",
        "pdf" => "application/pdf",
        "cjs" | "conf" | "cpp" | "cs" | "css" | "go" | "h" | "hpp" | "html" | "ini" | "java"
        | "js" | "jsx" | "mjs" | "py" | "rs" | "sh" | "sql" | "toml" | "ts" | "tsx" | "xml"
        | "yaml" | "yml" => "text/plain",
        _ => "application/octet-stream",
    }
}

fn main() {
    let mut builder = tauri::Builder::default();
    #[cfg(desktop)]
    {
        builder = builder.plugin(tauri_plugin_single_instance::init(|_app, _argv, _cwd| {}));
    }
    builder
        .plugin(tauri_plugin_deep_link::init())
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_dialog::init())
        .plugin(tauri_plugin_updater::Builder::new().build())
        .manage(HostState {
            nonce: nonce(),
            process: Mutex::new(None),
            credential_cache: Mutex::new(HashMap::new()),
        })
        .on_page_load(|webview, payload| {
            if matches!(payload.event(), PageLoadEvent::Finished) {
                let _ = webview.window().show();
            }
        })
        .setup(|app| {
            let app_handle = app.handle().clone();
            let reveal_handle = app.handle().clone();
            std::thread::spawn(move || {
                std::thread::sleep(Duration::from_millis(1200));
                if let Some(window) = reveal_handle.get_webview_window("main") {
                    let _ = window.show();
                }
            });
            tauri::async_runtime::spawn_blocking(move || {
                let state = app_handle.state::<HostState>();
                let _ = warm_provider_credentials(&app_handle, state.inner());
            });
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            host_rpc,
            credential_set,
            credential_status,
            credential_delete,
            pick_directory,
            pick_files,
            pick_skill_file
        ])
        .run(tauri::generate_context!())
        .expect("error while running Berry Desktop");
}

#[cfg(test)]
mod tests {
    use super::*;

    fn signed_policy_fixture() -> (Vec<u8>, String) {
        use base64::Engine;
        use ed25519_dalek::{Signer, SigningKey};
        let signing_key = SigningKey::from_bytes(&[7_u8; 32]);
        let mut value = serde_json::json!({
            "version": 1,
            "organization": { "id": "acme", "name": "Acme" },
            "issuedAt": "2026-07-10T00:00:00Z",
            "policy": {
                "execpolicy": [],
                "modelAllowlist": ["openai/*"],
                "mcpAllowlist": [],
                "pluginAllowlist": [],
                "sandboxFloor": "workspace-write",
                "telemetry": "disabled"
            },
            "signature": { "algorithm": "ed25519", "keyId": "test", "value": "" }
        });
        let mut unsigned = value.clone();
        unsigned.as_object_mut().expect("object").remove("signature");
        let signature = signing_key.sign(canonical_policy_json(&unsigned).as_bytes());
        value["signature"]["value"] = Value::String(base64::engine::general_purpose::STANDARD.encode(signature.to_bytes()));
        (
            serde_json::to_vec(&value).expect("policy bytes"),
            base64::engine::general_purpose::STANDARD.encode(signing_key.verifying_key().to_bytes()),
        )
    }

    #[test]
    fn managed_policy_signature_accepts_canonical_signed_payload() {
        let (bytes, public_key) = signed_policy_fixture();
        verify_managed_policy_bytes(&bytes, &public_key).expect("verified policy");
    }

    #[test]
    fn managed_policy_signature_rejects_tampering() {
        let (bytes, public_key) = signed_policy_fixture();
        let mut value: Value = serde_json::from_slice(&bytes).expect("policy");
        value["policy"]["sandboxFloor"] = Value::String("danger-full-access".to_string());
        let tampered = serde_json::to_vec(&value).expect("tampered");
        assert!(verify_managed_policy_bytes(&tampered, &public_key).is_err());
    }

    #[test]
    fn credential_round_trips_through_legacy_envelope() {
        let secret = "sk-test-1234567890";
        let sealed = encrypt_credential(secret).expect("encrypt");
        assert!(sealed.starts_with(CREDENTIAL_ENC_PREFIX));
        assert_eq!(sealed.matches('.').count(), 2);
        assert_eq!(decrypt_credential(&sealed).expect("decrypt"), secret);
    }

    #[test]
    fn plaintext_values_pass_through_unchanged() {
        assert_eq!(
            decrypt_credential("sk-plain").expect("passthrough"),
            "sk-plain"
        );
    }

    #[test]
    fn tampered_ciphertext_is_rejected() {
        let sealed = encrypt_credential("sk-test").expect("encrypt");
        let mut tampered = sealed.clone();
        tampered.pop();
        tampered.push(if sealed.ends_with('A') { 'B' } else { 'A' });
        assert!(decrypt_credential(&tampered).is_err());
    }

    #[test]
    fn agent_turn_and_mcp_reconnect_inject_credentials_from_the_shell_cache() {
        let state = HostState {
            nonce: "test".to_string(),
            process: Mutex::new(None),
            credential_cache: Mutex::new(HashMap::from([
                ("model-key".to_string(), "model-secret".to_string()),
                ("web-search-brave".to_string(), "search-secret".to_string()),
                ("mcp-oauth-1".to_string(), "mcp-secret".to_string()),
            ])),
        };
        let params = serde_json::json!({
            "credentialRef": "model-key",
            "webSearchCredentialRef": "web-search-brave",
            "mcpCredentialRefs": ["mcp-oauth-1"]
        });
        let injected = inject_credentials(&state, "agent.turn", Some(params))
            .expect("inject")
            .expect("params");
        assert_eq!(injected.get("apiKey"), Some(&Value::String("model-secret".to_string())));
        assert_eq!(injected.get("webSearchApiKey"), Some(&Value::String("search-secret".to_string())));
        assert_eq!(injected.get("mcpCredentials").and_then(|value| value.get("mcp-oauth-1")), Some(&Value::String("mcp-secret".to_string())));
        let reconnect = inject_credentials(
            &state,
            "mcp.server.reconnect",
            Some(serde_json::json!({ "id": "mcp_1", "credentialRef": "mcp-oauth-1" })),
        )
        .expect("inject reconnect")
        .expect("reconnect params");
        assert_eq!(reconnect.get("mcpCredential"), Some(&Value::String("mcp-secret".to_string())));
        let review = inject_credentials(
            &state,
            "review.start",
            Some(serde_json::json!({ "reviewSessionId": "review_1", "credentialRef": "model-key" })),
        )
        .expect("inject review")
        .expect("review params");
        assert_eq!(review.get("apiKey"), Some(&Value::String("model-secret".to_string())));
        let pr_draft = inject_credentials(
            &state,
            "git.pr.draft",
            Some(serde_json::json!({ "taskId": "task_1", "credentialRef": "model-key" })),
        )
        .expect("inject pr draft")
        .expect("pr draft params");
        assert_eq!(pr_draft.get("apiKey"), Some(&Value::String("model-secret".to_string())));
    }
}
