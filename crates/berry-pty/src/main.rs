use std::collections::HashMap;
use std::io::{BufRead, Read, Write};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine;
use portable_pty::{native_pty_system, ChildKiller, CommandBuilder, MasterPty, PtySize};
use serde::Deserialize;
use serde_json::json;

const KILL_GRACE: Duration = Duration::from_secs(3);

#[derive(Deserialize)]
#[serde(tag = "op", rename_all = "lowercase")]
enum Command {
    Create {
        id: String,
        shell: String,
        args: Option<Vec<String>>,
        cwd: Option<String>,
        cols: Option<u16>,
        rows: Option<u16>,
        env: Option<HashMap<String, String>>,
    },
    Write {
        id: String,
        #[serde(rename = "dataB64")]
        data_b64: String,
    },
    Resize {
        id: String,
        cols: u16,
        rows: u16,
    },
    Kill {
        id: String,
    },
    Shutdown,
}

#[derive(Clone)]
struct EventWriter {
    stdout: Arc<Mutex<std::io::Stdout>>,
}

impl EventWriter {
    fn new() -> Self {
        Self {
            stdout: Arc::new(Mutex::new(std::io::stdout())),
        }
    }

    fn emit(&self, value: serde_json::Value) {
        let mut out = self.stdout.lock().unwrap();
        let _ = serde_json::to_writer(&mut *out, &value);
        let _ = out.write_all(b"\n");
        let _ = out.flush();
    }

    fn error(&self, id: &str, message: &str) {
        self.emit(json!({ "event": "error", "id": id, "message": message }));
    }
}

struct Session {
    master: Mutex<Box<dyn MasterPty + Send>>,
    writer: Mutex<Box<dyn Write + Send>>,
    killer: Mutex<Box<dyn ChildKiller + Send + Sync>>,
    pid: Option<u32>,
}

type Sessions = Arc<Mutex<HashMap<String, Arc<Session>>>>;

fn main() {
    let events = EventWriter::new();
    let sessions: Sessions = Arc::new(Mutex::new(HashMap::new()));
    let stdin = std::io::stdin();

    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        match serde_json::from_str::<Command>(&line) {
            Ok(Command::Create {
                id,
                shell,
                args,
                cwd,
                cols,
                rows,
                env,
            }) => {
                if let Err(message) =
                    create(&sessions, &events, &id, &shell, args, cwd, cols, rows, env)
                {
                    events.error(&id, &message);
                }
            }
            Ok(Command::Write { id, data_b64 }) => write_data(&sessions, &events, &id, &data_b64),
            Ok(Command::Resize { id, cols, rows }) => resize(&sessions, &events, &id, cols, rows),
            Ok(Command::Kill { id }) => kill(&sessions, &events, &id),
            Ok(Command::Shutdown) => break,
            Err(err) => events.error("", &format!("invalid command: {err}")),
        }
    }

    shutdown_all(&sessions);
    std::process::exit(0);
}

#[allow(clippy::too_many_arguments)]
fn create(
    sessions: &Sessions,
    events: &EventWriter,
    id: &str,
    shell: &str,
    args: Option<Vec<String>>,
    cwd: Option<String>,
    cols: Option<u16>,
    rows: Option<u16>,
    env: Option<HashMap<String, String>>,
) -> Result<(), String> {
    if sessions.lock().unwrap().contains_key(id) {
        return Err(format!("terminal {id} already exists"));
    }
    let pty = native_pty_system();
    let pair = pty
        .openpty(PtySize {
            rows: rows.unwrap_or(32),
            cols: cols.unwrap_or(120),
            pixel_width: 0,
            pixel_height: 0,
        })
        .map_err(|err| err.to_string())?;

    let mut command = CommandBuilder::new(shell);
    for arg in args.unwrap_or_default() {
        command.arg(arg);
    }
    if let Some(cwd) = cwd {
        command.cwd(cwd);
    }
    let env = env.unwrap_or_default();
    if !env.contains_key("TERM") {
        command.env("TERM", "xterm-256color");
    }
    for (key, value) in env {
        command.env(key, value);
    }

    let mut child = pair
        .slave
        .spawn_command(command)
        .map_err(|err| err.to_string())?;
    drop(pair.slave);

    let pid = child.process_id();
    let killer = child.clone_killer();
    let mut reader = pair
        .master
        .try_clone_reader()
        .map_err(|err| err.to_string())?;
    let writer = pair.master.take_writer().map_err(|err| err.to_string())?;

    sessions.lock().unwrap().insert(
        id.to_string(),
        Arc::new(Session {
            master: Mutex::new(pair.master),
            writer: Mutex::new(writer),
            killer: Mutex::new(killer),
            pid,
        }),
    );
    events.emit(json!({ "event": "created", "id": id }));

    let id = id.to_string();
    let events = events.clone();
    let sessions = Arc::clone(sessions);
    thread::spawn(move || {
        let mut seq: u64 = 0;
        let mut buffer = [0u8; 8192];
        loop {
            match reader.read(&mut buffer) {
                Ok(0) | Err(_) => break,
                Ok(n) => {
                    events.emit(json!({
                        "event": "output",
                        "id": id,
                        "dataB64": BASE64.encode(&buffer[..n]),
                        "seq": seq,
                    }));
                    seq += 1;
                }
            }
        }
        let exit_code = child
            .wait()
            .map(|status| i64::from(status.exit_code()))
            .unwrap_or(-1);
        sessions.lock().unwrap().remove(&id);
        events.emit(json!({ "event": "exit", "id": id, "exitCode": exit_code }));
    });
    Ok(())
}

fn write_data(sessions: &Sessions, events: &EventWriter, id: &str, data_b64: &str) {
    let Some(session) = get_session(sessions, id) else {
        events.error(id, "terminal not found");
        return;
    };
    let data = match BASE64.decode(data_b64) {
        Ok(data) => data,
        Err(err) => {
            events.error(id, &format!("invalid base64: {err}"));
            return;
        }
    };
    let mut writer = session.writer.lock().unwrap();
    if let Err(err) = writer.write_all(&data).and_then(|()| writer.flush()) {
        events.error(id, &format!("write failed: {err}"));
    }
}

fn resize(sessions: &Sessions, events: &EventWriter, id: &str, cols: u16, rows: u16) {
    let Some(session) = get_session(sessions, id) else {
        events.error(id, "terminal not found");
        return;
    };
    let result = session.master.lock().unwrap().resize(PtySize {
        rows,
        cols,
        pixel_width: 0,
        pixel_height: 0,
    });
    if let Err(err) = result {
        events.error(id, &format!("resize failed: {err}"));
    }
}

fn kill(sessions: &Sessions, events: &EventWriter, id: &str) {
    let Some(session) = get_session(sessions, id) else {
        events.error(id, "terminal not found");
        return;
    };
    signal_session(&session, Signal::Term);
    let id = id.to_string();
    let sessions = Arc::clone(sessions);
    thread::spawn(move || {
        thread::sleep(KILL_GRACE);
        let survivor = sessions.lock().unwrap().get(&id).map(Arc::clone);
        if let Some(session) = survivor {
            signal_session(&session, Signal::Kill);
        }
    });
}

fn shutdown_all(sessions: &Sessions) {
    let snapshot: Vec<Arc<Session>> = sessions.lock().unwrap().values().map(Arc::clone).collect();
    if snapshot.is_empty() {
        return;
    }
    for session in &snapshot {
        signal_session(session, Signal::Term);
    }
    let deadline = Instant::now() + KILL_GRACE;
    while Instant::now() < deadline {
        if sessions.lock().unwrap().is_empty() {
            return;
        }
        thread::sleep(Duration::from_millis(50));
    }
    let survivors: Vec<Arc<Session>> = sessions.lock().unwrap().values().map(Arc::clone).collect();
    for session in &survivors {
        signal_session(session, Signal::Kill);
    }
}

fn get_session(sessions: &Sessions, id: &str) -> Option<Arc<Session>> {
    sessions.lock().unwrap().get(id).map(Arc::clone)
}

enum Signal {
    Term,
    Kill,
}

#[cfg(unix)]
fn signal_session(session: &Session, signal: Signal) {
    let signal_number = match signal {
        Signal::Term => libc::SIGTERM,
        Signal::Kill => libc::SIGKILL,
    };
    // The PTY child is spawned via setsid, so its pid is the process group id.
    if let Some(pid) = session.pid {
        for descendant in descendant_pids(pid) {
            let _ = unsafe { libc::kill(descendant as libc::pid_t, signal_number) };
        }
        let result = unsafe { libc::kill(-(pid as libc::pid_t), signal_number) };
        if result == 0 {
            return;
        }
    }
    let _ = session.killer.lock().unwrap().kill();
}

#[cfg(unix)]
fn descendant_pids(root: u32) -> Vec<u32> {
    let Ok(output) = std::process::Command::new("ps")
        .args(["-axo", "pid=,ppid="])
        .output()
    else {
        return Vec::new();
    };
    let rows: Vec<(u32, u32)> = String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| {
            let mut fields = line.split_whitespace();
            Some((fields.next()?.parse().ok()?, fields.next()?.parse().ok()?))
        })
        .collect();
    let mut descendants = Vec::new();
    let mut parents = vec![root];
    while let Some(parent) = parents.pop() {
        for (pid, ppid) in &rows {
            if *ppid == parent && !descendants.contains(pid) {
                descendants.push(*pid);
                parents.push(*pid);
            }
        }
    }
    descendants.reverse();
    descendants
}

#[cfg(windows)]
fn signal_session(session: &Session, _signal: Signal) {
    if let Some(pid) = session.pid {
        let status = std::process::Command::new("taskkill")
            .args(["/PID", &pid.to_string(), "/T", "/F"])
            .status();
        if status.map(|status| status.success()).unwrap_or(false) {
            return;
        }
    }
    let _ = session.killer.lock().unwrap().kill();
}

#[cfg(not(any(unix, windows)))]
fn signal_session(session: &Session, _signal: Signal) {
    let _ = session.killer.lock().unwrap().kill();
}
