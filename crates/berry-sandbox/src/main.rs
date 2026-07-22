use std::env;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitCode};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde::Deserialize;

#[derive(Deserialize)]
#[serde(tag = "tier", rename_all = "kebab-case")]
enum Policy {
    ReadOnly,
    WorkspaceWrite {
        #[serde(rename = "writableRoots")]
        writable_roots: Vec<String>,
        network: Network,
    },
    DangerFullAccess,
}

#[derive(Deserialize, PartialEq)]
#[serde(rename_all = "lowercase")]
enum Network {
    On,
    Off,
}

fn main() -> ExitCode {
    match run() {
        Ok(code) => ExitCode::from(code.clamp(0, 255) as u8),
        Err(message) => {
            eprintln!("berry-sandbox: {message}");
            ExitCode::from(126)
        }
    }
}

fn run() -> Result<i32, String> {
    let mut args = env::args().skip(1);
    let first = args.next();
    #[cfg(target_os = "linux")]
    if first.as_deref() == Some("--inner-seccomp") {
        if args.next().as_deref() != Some("--") {
            return Err("missing -- before inner command".into());
        }
        let command = args.next().ok_or("missing inner command")?;
        let command_args: Vec<String> = args.collect();
        install_network_seccomp()?;
        return direct_command(&command, &command_args)
            .status()
            .map(|status| status.code().unwrap_or(1))
            .map_err(|error| format!("inner spawn failed: {error}"));
    }
    if first.as_deref() != Some("--policy-base64") {
        return Err("usage: berry-sandbox --policy-base64 <json> -- <command> [args...]".into());
    }
    let encoded = args.next().ok_or("missing policy")?;
    if args.next().as_deref() != Some("--") {
        return Err("missing -- before command".into());
    }
    let command = args.next().ok_or("missing command")?;
    let command_args: Vec<String> = args.collect();
    let bytes = BASE64
        .decode(encoded)
        .map_err(|error| format!("invalid policy base64: {error}"))?;
    let policy: Policy =
        serde_json::from_slice(&bytes).map_err(|error| format!("invalid policy JSON: {error}"))?;

    #[cfg(target_os = "macos")]
    let mut child = macos_command(&policy, &command, &command_args)?;
    #[cfg(target_os = "linux")]
    let mut child = linux_command(&policy, &command, &command_args)?;
    #[cfg(not(any(target_os = "macos", target_os = "linux")))]
    let mut child = direct_command(&command, &command_args);

    let status = child
        .status()
        .map_err(|error| format!("spawn failed: {error}"))?;
    Ok(status.code().unwrap_or(1))
}

#[cfg(target_os = "macos")]
fn macos_command(policy: &Policy, command: &str, args: &[String]) -> Result<Command, String> {
    let profile = seatbelt_profile(policy)?;
    let mut child = Command::new("/usr/bin/sandbox-exec");
    child.args(["-p", &profile, command]).args(args);
    Ok(child)
}

#[cfg(target_os = "linux")]
fn linux_command(policy: &Policy, command: &str, args: &[String]) -> Result<Command, String> {
    if matches!(policy, Policy::DangerFullAccess) {
        return Ok(direct_command(command, args));
    }
    let binary = ["/usr/bin/bwrap", "/bin/bwrap"]
        .into_iter()
        .find(|path| Path::new(path).exists())
        .ok_or("bubblewrap is not installed")?;
    let mut child = Command::new(binary);
    child.args([
        "--die-with-parent",
        "--new-session",
        "--ro-bind",
        "/",
        "/",
        "--proc",
        "/proc",
        "--dev",
        "/dev",
    ]);
    let mut network_off = false;
    match policy {
        Policy::ReadOnly => {
            child.arg("--unshare-net");
            network_off = true;
        }
        Policy::WorkspaceWrite {
            writable_roots,
            network,
        } => {
            for root in canonical_roots(writable_roots)? {
                child.args([
                    "--bind",
                    root.to_string_lossy().as_ref(),
                    root.to_string_lossy().as_ref(),
                ]);
            }
            if *network == Network::Off {
                child.arg("--unshare-net");
                network_off = true;
            }
        }
        Policy::DangerFullAccess => {}
    }
    child.arg("--");
    if network_off {
        child
            .arg(
                env::current_exe()
                    .map_err(|error| format!("cannot resolve sandbox helper: {error}"))?,
            )
            .args(["--inner-seccomp", "--", command])
            .args(args);
    } else {
        child.arg(command).args(args);
    }
    Ok(child)
}

#[cfg(target_os = "linux")]
fn install_network_seccomp() -> Result<(), String> {
    let denied = [
        libc::SYS_socket,
        libc::SYS_connect,
        libc::SYS_bind,
        libc::SYS_listen,
        libc::SYS_accept,
        libc::SYS_accept4,
        libc::SYS_sendto,
        libc::SYS_recvfrom,
        libc::SYS_sendmsg,
        libc::SYS_recvmsg,
        libc::SYS_socketpair,
    ];
    let mut filters = Vec::<libc::sock_filter>::with_capacity(denied.len() * 2 + 2);
    filters.push(stmt((libc::BPF_LD | libc::BPF_W | libc::BPF_ABS) as u16, 0));
    for syscall in denied {
        filters.push(jump(
            (libc::BPF_JMP | libc::BPF_JEQ | libc::BPF_K) as u16,
            syscall as u32,
            0,
            1,
        ));
        filters.push(stmt(
            (libc::BPF_RET | libc::BPF_K) as u16,
            0x0005_0000 | libc::EPERM as u32,
        ));
    }
    filters.push(stmt((libc::BPF_RET | libc::BPF_K) as u16, 0x7fff_0000));
    let mut program = libc::sock_fprog {
        len: filters.len() as u16,
        filter: filters.as_mut_ptr(),
    };
    // SAFETY: `program` references `filters` for the duration of both prctl calls.
    let no_new_privs = unsafe { libc::prctl(libc::PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) };
    if no_new_privs != 0 {
        return Err(format!(
            "PR_SET_NO_NEW_PRIVS failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    // SAFETY: kernel copies the validated classic-BPF program during this call.
    let installed = unsafe {
        libc::prctl(
            libc::PR_SET_SECCOMP,
            2,
            &mut program as *mut libc::sock_fprog,
        )
    };
    if installed != 0 {
        return Err(format!(
            "seccomp filter install failed: {}",
            std::io::Error::last_os_error()
        ));
    }
    Ok(())
}

#[cfg(target_os = "linux")]
fn stmt(code: u16, k: u32) -> libc::sock_filter {
    libc::sock_filter {
        code,
        jt: 0,
        jf: 0,
        k,
    }
}

#[cfg(target_os = "linux")]
fn jump(code: u16, k: u32, jt: u8, jf: u8) -> libc::sock_filter {
    libc::sock_filter { code, jt, jf, k }
}

#[cfg(not(target_os = "macos"))]
fn direct_command(command: &str, args: &[String]) -> Command {
    let mut child = Command::new(command);
    child.args(args);
    child
}

#[cfg(target_os = "macos")]
fn seatbelt_profile(policy: &Policy) -> Result<String, String> {
    if matches!(policy, Policy::DangerFullAccess) {
        return Ok("(version 1) (allow default)".into());
    }
    let mut lines = vec![
        "(version 1)".to_string(),
        "(deny default)".to_string(),
        "(allow process*)".to_string(),
        "(allow file-read*)".to_string(),
        "(allow sysctl-read)".to_string(),
        "(allow mach-lookup)".to_string(),
        "(allow signal)".to_string(),
        "(allow ipc-posix-shm)".to_string(),
        "(allow file-write* (literal \"/dev/null\"))".to_string(),
    ];
    if let Policy::WorkspaceWrite {
        writable_roots,
        network,
    } = policy
    {
        let roots = canonical_roots(writable_roots)?;
        lines.push(format!(
            "(allow file-write* {})",
            roots
                .iter()
                .map(|root| format!("(subpath {})", sbpl(root)))
                .collect::<Vec<_>>()
                .join(" ")
        ));
        for root in roots {
            lines.push(format!("(deny file-write* (subpath {}) (subpath {}) (subpath {}) (subpath {}) (subpath {}))",
                sbpl(&root.join(".git/hooks")), sbpl(&root.join(".berry")), sbpl(&root.join(".codex")), sbpl(&root.join(".agents")), sbpl(&root.join(".ssh"))));
        }
        if *network == Network::On {
            lines.push("(allow network*)".to_string());
        }
    }
    Ok(lines.join("\n"))
}

fn canonical_roots(roots: &[String]) -> Result<Vec<PathBuf>, String> {
    roots
        .iter()
        .map(|root| {
            let path = PathBuf::from(root);
            path.canonicalize()
                .or_else(|_| Ok::<PathBuf, std::io::Error>(path))
                .map_err(|error| error.to_string())
        })
        .collect()
}

#[cfg(target_os = "macos")]
fn sbpl(path: &Path) -> String {
    serde_json::to_string(&path.to_string_lossy()).unwrap_or_else(|_| "\"\"".into())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(target_os = "macos")]
    #[test]
    fn profile_is_deny_default_and_canonical() {
        let root = env::current_dir().unwrap();
        let profile = seatbelt_profile(&Policy::WorkspaceWrite {
            writable_roots: vec![root.to_string_lossy().into()],
            network: Network::Off,
        })
        .unwrap();
        assert!(profile.contains("(deny default)"));
        assert!(profile.contains(".git/hooks"));
        assert!(!profile.contains("(allow network*)"));
    }
}
