//! Drive the built binary over stdin/stdout.

use std::io::Write;
use std::process::{Command, Stdio};

#[test]
fn one_response_per_line_in_order() {
    let input = concat!(
        "{\"op\":\"lexidecimal.encode\",\"value\":\"16\"}\n",
        "not json\n",
        "{\"op\":\"diffuse16.decode\",\"text\":\"0wb1z\"}\n",
        "{\"op\":\"what\"}\n",
        "\n",
        "{\"op\":\"flow.normalize\",\"id\":\"..\"}\n",
        "{\"op\":\"lexidecimal.sizePrefix\",\"size\":\"0\",\"negative\":true}"
    );
    let mut child = Command::new(env!("CARGO_BIN_EXE_basinsync-oracle"))
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    child.stdin.take().unwrap().write_all(input.as_bytes()).unwrap();
    let out = child.wait_with_output().unwrap();
    assert!(out.status.success());
    let lines: Vec<&str> = std::str::from_utf8(&out.stdout).unwrap().lines().collect();
    assert_eq!(lines.len(), 7);
    assert_eq!(lines[0], r#"{"ok":"0zh10"}"#);
    assert!(lines[1].starts_with(r#"{"error""#));
    assert_eq!(lines[2], r#"{"ok":"27"}"#);
    assert_eq!(lines[3], r#"{"unsupported":true}"#);
    assert!(lines[4].starts_with(r#"{"error""#));
    assert!(lines[5].starts_with(r#"{"error""#));
    assert_eq!(lines[6], r#"{"ok":"v"}"#);
}
