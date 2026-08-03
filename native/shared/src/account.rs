//! The Workbench account the daemon should sync as.
//!
//! The session lives in the OS credential store under one fixed name, so every app and the
//! resident see the same one. The folder names derived from it are part of the sync
//! contract: change how a segment is built and the daemon starts syncing into a directory
//! that looks new and empty.

use crate::secure_storage;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ActiveWorkbenchAccount {
  pub user_id: String,
  pub username: String,
  pub access_token: Option<String>,
}

pub fn parse_active_workbench_account(raw: &str) -> Option<ActiveWorkbenchAccount> {
  let parsed = serde_json::from_str::<serde_json::Value>(raw).ok()?;
  let user = parsed.get("user")?;
  let user_id = user
    .get("id")
    .and_then(serde_json::Value::as_str)
    .map(str::trim)
    .filter(|value| !value.is_empty())?
    .to_string();
  let username = user
    .get("username")
    .and_then(serde_json::Value::as_str)
    .map(str::trim)
    .filter(|value| !value.is_empty())
    .unwrap_or("user")
    .to_string();
  let access_token = parsed
    .get("accessToken")
    .and_then(serde_json::Value::as_str)
    .map(str::trim)
    .filter(|value| !value.is_empty())
    .map(ToString::to_string);

  Some(ActiveWorkbenchAccount {
    user_id,
    username,
    access_token,
  })
}

pub fn active_workbench_account() -> Option<ActiveWorkbenchAccount> {
  secure_storage::read()
    .ok()
    .flatten()
    .and_then(|raw| parse_active_workbench_account(&raw))
}

pub fn sanitize_folder_segment(raw: &str) -> String {
  let mut sanitized = String::new();
  let mut previous_separator = false;
  for ch in raw.trim().chars() {
    let replacement = match ch {
      '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => Some('_'),
      c if c.is_control() => Some('_'),
      c if c.is_whitespace() => Some('-'),
      c => Some(c),
    };
    let Some(next) = replacement else {
      continue;
    };
    let is_separator = next == '_' || next == '-' || next == '.';
    if is_separator && previous_separator {
      continue;
    }
    sanitized.push(next);
    previous_separator = is_separator;
    if sanitized.chars().count() >= 64 {
      break;
    }
  }

  let trimmed = sanitized.trim_matches(|ch| ch == '_' || ch == '-' || ch == '.');
  if trimmed.is_empty() {
    "user".to_string()
  } else {
    trimmed.to_string()
  }
}

pub fn take_segment_prefix(raw: &str, max_chars: usize) -> String {
  raw.chars().take(max_chars).collect()
}

pub fn account_folder_segment(account: Option<&ActiveWorkbenchAccount>) -> String {
  let Some(account) = account else {
    return "guest".to_string();
  };
  let username = sanitize_folder_segment(&account.username);
  let user_id = sanitize_folder_segment(&account.user_id);
  format!("{}-{}", username, take_segment_prefix(&user_id, 12))
}

pub fn account_sync_root_id(account: Option<&ActiveWorkbenchAccount>) -> String {
  let Some(account) = account else {
    return "guest".to_string();
  };
  format!(
    "account-{}",
    take_segment_prefix(&sanitize_folder_segment(&account.user_id), 32)
  )
}

pub fn account_label(account: Option<&ActiveWorkbenchAccount>) -> String {
  account
    .map(|account| account.username.trim())
    .filter(|value| !value.is_empty())
    .unwrap_or("Guest")
    .to_string()
}

#[cfg(test)]
mod tests {
  use super::*;

  fn account(user_id: &str, username: &str) -> ActiveWorkbenchAccount {
    ActiveWorkbenchAccount {
      user_id: user_id.to_string(),
      username: username.to_string(),
      access_token: None,
    }
  }

  #[test]
  fn parses_a_session_payload() {
    let parsed = parse_active_workbench_account(
      r#"{"user":{"id":"abc","username":"nh"},"accessToken":"token"}"#,
    )
    .expect("a well-formed session should parse");
    assert_eq!(parsed.user_id, "abc");
    assert_eq!(parsed.username, "nh");
    assert_eq!(parsed.access_token.as_deref(), Some("token"));
  }

  #[test]
  fn a_session_without_a_user_id_is_not_an_account() {
    // Without an id there is no stable folder to sync into, so guest is the honest answer.
    assert!(parse_active_workbench_account(r#"{"user":{"username":"nh"}}"#).is_none());
  }

  #[test]
  fn folder_segments_collapse_runs_of_separators() {
    // A run collapses to whichever separator opened it, so the two spaces, two slashes and
    // two more spaces between `a` and `b` come out as the single `-` the first space made.
    assert_eq!(sanitize_folder_segment("a  //  b"), "a-b");
    assert_eq!(sanitize_folder_segment("a//  b"), "a_b");
  }

  #[test]
  fn folder_segments_never_come_back_empty() {
    assert_eq!(sanitize_folder_segment("///"), "user");
    assert_eq!(sanitize_folder_segment("   "), "user");
  }

  #[test]
  fn signed_out_folders_are_the_guest_folder() {
    assert_eq!(account_folder_segment(None), "guest");
    assert_eq!(account_sync_root_id(None), "guest");
    assert_eq!(account_label(None), "Guest");
  }

  #[test]
  fn the_folder_segment_truncates_the_user_id_but_not_the_name() {
    let segment = account_folder_segment(Some(&account("0123456789abcdefghij", "nh")));
    assert_eq!(segment, "nh-0123456789ab");
  }

  #[test]
  fn builds_account_scoped_folder_segments() {
    // Pinned against real-shaped values: the folder name a signed-in user's sync root gets
    // must not move, or their existing tree looks empty after an update.
    let account = account("user-1234567890abcdef", "Hayato Nakanishi");
    assert_eq!(
      account_folder_segment(Some(&account)),
      "Hayato-Nakanishi-user-1234567"
    );
    assert_eq!(
      account_sync_root_id(Some(&account)),
      "account-user-1234567890abcdef"
    );
    assert_eq!(account_label(Some(&account)), "Hayato Nakanishi");
  }
}
