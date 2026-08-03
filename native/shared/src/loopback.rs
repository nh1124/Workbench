//! The sync daemon's loopback API, spoken over a raw socket.
//!
//! Deliberately hand-rolled HTTP/1.0 rather than an HTTP client crate: this is a handful of
//! requests to 127.0.0.1 with one header, and the daemon closes the connection per response.

use std::io::{Read, Write};
use std::net::{SocketAddr, TcpStream};
use std::time::Duration;

pub const DEFAULT_DAEMON_HTTP_PORT: u16 = 35780;
const DAEMON_STATUS_TIMEOUT: Duration = Duration::from_secs(2);
const MAX_DAEMON_STATUS_RESPONSE_BYTES: usize = 1024 * 1024;

pub fn configured_daemon_port(port: Option<u16>) -> Result<u16, String> {
  if let Some(port) = port {
    if port == 0 {
      return Err("sync daemon status port cannot be 0".to_string());
    }
    return Ok(port);
  }

  match std::env::var("WORKBENCH_DAEMON_HTTP_PORT") {
    Ok(value) => {
      let trimmed = value.trim();
      if trimmed.is_empty() {
        return Ok(DEFAULT_DAEMON_HTTP_PORT);
      }

      let parsed = trimmed.parse::<u16>().map_err(|_| {
        format!("WORKBENCH_DAEMON_HTTP_PORT must be between 1 and 65535, got {trimmed}")
      })?;
      if parsed == 0 {
        Err(
          "sync daemon status server is disabled because WORKBENCH_DAEMON_HTTP_PORT=0".to_string(),
        )
      } else {
        Ok(parsed)
      }
    }
    Err(_) => Ok(DEFAULT_DAEMON_HTTP_PORT),
  }
}

/// Issues one request against the daemon's loopback API and returns `(status code, body)`.
///
/// Reaching the daemon at all is a different question from being allowed to read it, so the
/// HTTP status is handed back rather than turned into an error here. See [`is_occupied`]
/// for why that distinction matters.
pub fn request(port: u16, path: &str, token: Option<&str>) -> Result<(String, String), String> {
  request_with(port, "GET", path, token, None)
}

pub fn request_with(
  port: u16,
  method: &str,
  path: &str,
  token: Option<&str>,
  body: Option<&str>,
) -> Result<(String, String), String> {
  let address = SocketAddr::from(([127, 0, 0, 1], port));
  let mut stream = TcpStream::connect_timeout(&address, DAEMON_STATUS_TIMEOUT)
    .map_err(|error| format!("failed to connect to sync daemon at {address}: {error}"))?;

  stream
    .set_read_timeout(Some(DAEMON_STATUS_TIMEOUT))
    .map_err(|error| format!("failed to set daemon status read timeout: {error}"))?;
  stream
    .set_write_timeout(Some(DAEMON_STATUS_TIMEOUT))
    .map_err(|error| format!("failed to set daemon status write timeout: {error}"))?;

  let auth_header = match token {
    Some(token) => format!("x-workbench-daemon-token: {token}\r\n"),
    None => String::new(),
  };
  let body_headers = match body {
    Some(body) => format!(
      "Content-Type: application/json\r\nContent-Length: {}\r\n",
      body.len()
    ),
    None => String::new(),
  };
  let request = format!(
    "{method} {path} HTTP/1.0\r\nHost: 127.0.0.1:{port}\r\nAccept: application/json\r\n{auth_header}{body_headers}Connection: close\r\n\r\n{}",
    body.unwrap_or("")
  );
  stream
    .write_all(request.as_bytes())
    .map_err(|error| format!("failed to send sync daemon request: {error}"))?;

  let mut response = Vec::new();
  let mut chunk = [0_u8; 8192];
  loop {
    let bytes_read = stream
      .read(&mut chunk)
      .map_err(|error| format!("failed to read sync daemon status: {error}"))?;
    if bytes_read == 0 {
      break;
    }
    response.extend_from_slice(&chunk[..bytes_read]);
    if response.len() > MAX_DAEMON_STATUS_RESPONSE_BYTES {
      return Err("sync daemon status response is too large".to_string());
    }
  }

  let response_text = String::from_utf8(response)
    .map_err(|error| format!("sync daemon status response was not UTF-8: {error}"))?;
  let (headers, body) = response_text
    .split_once("\r\n\r\n")
    .ok_or_else(|| "sync daemon status response was malformed".to_string())?;

  let status_line = headers
    .lines()
    .next()
    .ok_or_else(|| "sync daemon status response did not include a status line".to_string())?;
  let status_code = status_line
    .split_whitespace()
    .nth(1)
    .ok_or_else(|| format!("sync daemon status line was malformed: {status_line}"))?;

  Ok((status_code.to_string(), body.to_string()))
}

pub fn read_status(port: u16, token: Option<&str>) -> Result<serde_json::Value, String> {
  let (status_code, body) = request(port, "/status", token)?;

  if status_code != "200" {
    let detail = body.trim();
    if detail.is_empty() {
      return Err(format!(
        "sync daemon status request failed with HTTP {status_code}"
      ));
    }
    return Err(format!(
      "sync daemon status request failed with HTTP {status_code}: {detail}"
    ));
  }

  serde_json::from_str(body.trim())
    .map_err(|error| format!("failed to parse sync daemon status JSON: {error}"))
}

/// True when something is already serving the daemon's loopback port.
///
/// This drives the launch guard, so the question it must answer is "would spawning collide?"
/// — not "can I read the status?". Those came apart badly: `/status` needs a token the
/// daemon writes under the sync root, and probing it without one gets 401, which read as
/// "nothing is listening". Every app then spawned its own daemon and the losers died on
/// EADDRINUSE, which is precisely the silent double-start the guard exists to prevent.
///
/// `/health` is the one route the daemon exempts from auth (`loopbackAuthBypassed` in
/// `native/sync-daemon/src/httpApi.ts`). Any well-formed HTTP reply counts as occupied,
/// including a non-200: whatever is holding the port, binding it again would fail.
pub fn is_occupied(port: u16) -> bool {
  request(port, "/health", None).is_ok()
}

#[cfg(test)]
mod tests {
  use super::*;
  use std::net::TcpListener;

  /// Answers one request with `status_line`/`body` and hands back what it received.
  fn one_shot_server(status_line: &'static str, body: &'static str) -> (u16, std::thread::JoinHandle<String>) {
    let listener = TcpListener::bind(("127.0.0.1", 0)).expect("test listener should bind");
    let port = listener
      .local_addr()
      .expect("test listener should have an address")
      .port();
    let handle = std::thread::spawn(move || {
      let (mut stream, _) = listener.accept().expect("request should connect");
      let mut buffer = [0_u8; 1024];
      let read = stream.read(&mut buffer).expect("request should be readable");
      let received = String::from_utf8_lossy(&buffer[..read]).to_string();
      write!(
        stream,
        "{status_line}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
      )
      .expect("response should be written");
      received
    });
    (port, handle)
  }

  fn closed_port() -> u16 {
    let listener = TcpListener::bind(("127.0.0.1", 0)).expect("test listener should bind");
    let port = listener
      .local_addr()
      .expect("test listener should have an address")
      .port();
    drop(listener);
    port
  }

  #[test]
  fn detects_loopback_daemon_status() {
    let (port, server) = one_shot_server("HTTP/1.1 200 OK", r#"{"status":"ok"}"#);
    assert_eq!(
      read_status(port, None).expect("running status listener should be detected"),
      serde_json::json!({ "status": "ok" })
    );
    server.join().expect("status server should not panic");

    assert!(read_status(closed_port(), None).is_err());
  }

  /// The bug this pins: a live daemon answers `/status` with 401 when the caller has no
  /// token, and treating that as "nothing is listening" made every app spawn its own daemon.
  /// Occupancy must be decided by getting an answer at all, not by getting a 200.
  #[test]
  fn an_unauthorized_daemon_still_counts_as_occupying_the_port() {
    let (port, server) = one_shot_server(
      "HTTP/1.1 401 Unauthorized",
      r#"{"message":"Local daemon API token is required."}"#,
    );
    assert!(is_occupied(port));
    server.join().expect("probe server should not panic");
  }

  #[test]
  fn a_closed_port_is_not_occupied() {
    assert!(!is_occupied(closed_port()));
  }

  #[test]
  fn the_status_request_carries_the_daemon_token() {
    let (port, server) = one_shot_server("HTTP/1.1 200 OK", r#"{"status":"ok"}"#);
    read_status(port, Some("secret-token")).expect("status should be read");
    let request = server.join().expect("status server should not panic");
    assert!(request.contains("x-workbench-daemon-token: secret-token"));
  }

  #[test]
  fn a_body_is_sent_with_a_content_length() {
    let (port, server) = one_shot_server("HTTP/1.1 200 OK", "{}");
    request_with(port, "POST", "/leases", None, Some(r#"{"clientId":"x"}"#))
      .expect("a POST should complete");
    let received = server.join().expect("server should not panic");
    assert!(received.contains("POST /leases HTTP/1.0"));
    assert!(received.contains("Content-Length: 16"));
    assert!(received.ends_with(r#"{"clientId":"x"}"#));
  }

  #[test]
  fn the_port_falls_back_to_the_default_and_rejects_zero() {
    assert_eq!(
      configured_daemon_port(Some(41000)).expect("an explicit port should be accepted"),
      41000
    );
    assert!(configured_daemon_port(Some(0)).is_err());
  }
}
