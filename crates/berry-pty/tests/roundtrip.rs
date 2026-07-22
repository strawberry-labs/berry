use std::fs;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::mpsc::{self, Receiver};
use std::thread;
use std::time::{Duration, Instant};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use serde_json::{json, Value};

const READ_TIMEOUT: Duration = Duration::from_secs(20);

struct Sidecar {
    child: Child,
    stdin: ChildStdin,
    events: Receiver<Value>,
}

impl Sidecar {
    fn spawn() -> Self {
        let mut child = Command::new(env!("CARGO_BIN_EXE_berry-pty"))
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .expect("spawn berry-pty");
        let stdin = child.stdin.take().expect("stdin");
        let stdout = child.stdout.take().expect("stdout");
        let (sender, events) = mpsc::channel();
        thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                let Ok(value) = serde_json::from_str::<Value>(&line) else {
                    continue;
                };
                if sender.send(value).is_err() {
                    break;
                }
            }
        });
        Self {
            child,
            stdin,
            events,
        }
    }

    fn send(&mut self, value: Value) {
        let mut line = value.to_string();
        line.push('\n');
        self.stdin.write_all(line.as_bytes()).expect("write stdin");
        self.stdin.flush().expect("flush stdin");
    }

    fn next_event(&self) -> Value {
        self.events
            .recv_timeout(READ_TIMEOUT)
            .expect("event before timeout")
    }

    fn wait_for<F: Fn(&Value) -> bool>(&self, predicate: F) -> Value {
        loop {
            let event = self.next_event();
            if predicate(&event) {
                return event;
            }
        }
    }

    fn shutdown(mut self) {
        self.send(json!({ "op": "shutdown" }));
        let status = self.child.wait().expect("sidecar exit");
        assert!(status.success());
    }
}

fn event_is(value: &Value, event: &str, id: &str) -> bool {
    value["event"] == event && value["id"] == id
}

#[cfg(windows)]
fn shell_echo_exit() -> (&'static str, &'static [u8]) {
    ("cmd.exe", b"echo roundtrip-%BERRY_PTY_TEST%\r\nexit /b 0\r\n")
}

#[cfg(not(windows))]
fn shell_echo_exit() -> (&'static str, &'static [u8]) {
    ("/bin/sh", b"echo roundtrip-$BERRY_PTY_TEST\nexit 0\n")
}

#[cfg(windows)]
fn long_running_shell() -> &'static str {
    "cmd.exe"
}

#[cfg(not(windows))]
fn long_running_shell() -> &'static str {
    "/bin/cat"
}

#[test]
fn create_write_output_exit_roundtrip() {
    let mut sidecar = Sidecar::spawn();
    let cwd = std::env::temp_dir();
    let (shell, input) = shell_echo_exit();
    sidecar.send(json!({
        "op": "create",
        "id": "t1",
        "shell": shell,
        "cwd": cwd.to_string_lossy(),
        "cols": 80,
        "rows": 24,
        "env": { "BERRY_PTY_TEST": "pty-env-ok" },
    }));
    let created = sidecar.wait_for(|event| event_is(event, "created", "t1"));
    assert_eq!(created["event"], "created");

    sidecar.send(json!({ "op": "write", "id": "t1", "dataB64": BASE64.encode(input) }));

    let mut output = String::new();
    let mut last_seq: Option<u64> = None;
    let exit = loop {
        let event = sidecar.next_event();
        if event_is(&event, "exit", "t1") {
            break event;
        }
        if event_is(&event, "output", "t1") {
            let seq = event["seq"].as_u64().expect("seq");
            if let Some(previous) = last_seq {
                assert!(seq > previous, "seq must be monotonic");
            } else {
                assert_eq!(seq, 0, "seq must start at 0");
            }
            last_seq = Some(seq);
            let chunk = BASE64
                .decode(event["dataB64"].as_str().expect("dataB64"))
                .expect("valid base64 output");
            output.push_str(&String::from_utf8_lossy(&chunk));
        }
    };
    assert!(
        output.contains("roundtrip-pty-env-ok"),
        "expected expanded echo in output, got: {output:?}"
    );
    assert_eq!(exit["exitCode"], 0);

    sidecar.send(json!({ "op": "write", "id": "t1", "dataB64": BASE64.encode(b"x") }));
    let error = sidecar.wait_for(|event| event_is(event, "error", "t1"));
    assert!(error["message"]
        .as_str()
        .unwrap_or("")
        .contains("not found"));

    sidecar.shutdown();
}

#[test]
fn kill_terminates_the_process_group() {
    let mut sidecar = Sidecar::spawn();
    sidecar.send(json!({
        "op": "create",
        "id": "t2",
        "shell": long_running_shell(),
        "cols": 80,
        "rows": 24,
    }));
    sidecar.wait_for(|event| event_is(event, "created", "t2"));
    sidecar.send(json!({ "op": "kill", "id": "t2" }));
    let exit = sidecar.wait_for(|event| event_is(event, "exit", "t2"));
    assert!(exit["exitCode"].is_number());
    sidecar.shutdown();
}

#[cfg(windows)]
#[test]
fn shutdown_terminates_background_processes() {
    let mut sidecar = Sidecar::spawn();
    let pid_file = std::env::temp_dir().join(format!("berry-pty-child-{}.pid", std::process::id()));
    let _ = fs::remove_file(&pid_file);
    let path = pid_file.to_string_lossy().replace('\'', "''");
    let script = format!(
        "$p=Start-Process -PassThru -WindowStyle Hidden powershell -ArgumentList '-NoProfile','-Command','Start-Sleep -Seconds 30'; Set-Content -Path '{path}' -Value $p.Id; Start-Sleep -Seconds 30"
    );
    sidecar.send(json!({
        "op": "create",
        "id": "t_shutdown",
        "shell": "powershell.exe",
        "args": ["-NoProfile", "-Command", script],
        "cwd": std::env::temp_dir().to_string_lossy(),
        "cols": 80,
        "rows": 24,
    }));
    sidecar.wait_for(|event| event_is(event, "created", "t_shutdown"));

    let deadline = Instant::now() + Duration::from_secs(5);
    while !pid_file.exists() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(20));
    }
    let pid: u32 = fs::read_to_string(&pid_file)
        .expect("background pid file")
        .trim()
        .parse()
        .expect("background pid");
    sidecar.shutdown();

    let deadline = Instant::now() + Duration::from_secs(3);
    while process_exists(pid) && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(20));
    }
    assert!(
        !process_exists(pid),
        "background process {pid} survived sidecar shutdown"
    );
    let _ = fs::remove_file(pid_file);
}

#[cfg(unix)]
#[test]
fn create_passes_wrapper_arguments_to_the_shell_process() {
    let mut sidecar = Sidecar::spawn();
    sidecar.send(json!({
        "op": "create",
        "id": "t_args",
        "shell": "/bin/sh",
        "args": ["-c", "echo wrapper-args-ok"],
        "cols": 80,
        "rows": 24,
    }));
    sidecar.wait_for(|event| event_is(event, "created", "t_args"));
    let mut output = String::new();
    loop {
        let event = sidecar.next_event();
        if event_is(&event, "exit", "t_args") {
            assert_eq!(event["exitCode"], 0);
            break;
        }
        if event_is(&event, "output", "t_args") {
            let chunk = BASE64
                .decode(event["dataB64"].as_str().expect("dataB64"))
                .expect("valid base64 output");
            output.push_str(&String::from_utf8_lossy(&chunk));
        }
    }
    assert!(output.contains("wrapper-args-ok"), "missing argv output: {output:?}");
    sidecar.shutdown();
}

#[cfg(unix)]
#[test]
fn shutdown_terminates_background_processes() {
    let mut sidecar = Sidecar::spawn();
    let pid_file = std::env::temp_dir().join(format!("berry-pty-child-{}.pid", std::process::id()));
    let _ = fs::remove_file(&pid_file);
    sidecar.send(json!({
        "op": "create",
        "id": "t_shutdown",
        "shell": "/bin/sh",
        "cwd": std::env::temp_dir().to_string_lossy(),
        "cols": 80,
        "rows": 24,
    }));
    sidecar.wait_for(|event| event_is(event, "created", "t_shutdown"));
    let command = format!("sleep 30 & echo $! > {}\n", pid_file.to_string_lossy());
    sidecar.send(json!({ "op": "write", "id": "t_shutdown", "dataB64": BASE64.encode(command) }));

    let deadline = Instant::now() + Duration::from_secs(5);
    while !pid_file.exists() && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(20));
    }
    let pid: i32 = fs::read_to_string(&pid_file)
        .expect("background pid file")
        .trim()
        .parse()
        .expect("background pid");
    sidecar.shutdown();

    let deadline = Instant::now() + Duration::from_secs(3);
    while process_exists(pid) && Instant::now() < deadline {
        thread::sleep(Duration::from_millis(20));
    }
    assert!(
        !process_exists(pid),
        "background process {pid} survived sidecar shutdown"
    );
    let _ = fs::remove_file(pid_file);
}

#[cfg(unix)]
fn process_exists(pid: i32) -> bool {
    unsafe { libc::kill(pid, 0) == 0 }
}

#[cfg(windows)]
fn process_exists(pid: u32) -> bool {
    let output = Command::new("tasklist")
        .args(["/FI", &format!("PID eq {pid}"), "/NH"])
        .output()
        .expect("tasklist");
    String::from_utf8_lossy(&output.stdout).contains(&pid.to_string())
}

#[test]
fn rejects_invalid_commands_without_crashing() {
    let mut sidecar = Sidecar::spawn();
    sidecar
        .stdin
        .write_all(b"{\"op\":\"nope\"}\n")
        .expect("write stdin");
    sidecar.stdin.flush().expect("flush stdin");
    let error = sidecar.wait_for(|event| event["event"] == "error");
    assert!(error["message"]
        .as_str()
        .unwrap_or("")
        .contains("invalid command"));
    sidecar.shutdown();
}
