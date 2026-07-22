use std::process::{Child, Command, Stdio};

/// Terminates exactly one recorded child PID and, on Windows, its spawned process tree.
pub(crate) fn terminate_owned_process_tree(mut child: Child) {
    if child.try_wait().ok().flatten().is_some() {
        return;
    }

    #[cfg(windows)]
    {
        if taskkill_owned_process_tree(child.id()).is_ok() {
            let _ = child.wait();
            return;
        }
    }

    let _ = child.kill();
    let _ = child.wait();
}

#[cfg(windows)]
fn taskkill_owned_process_tree(pid: u32) -> Result<(), String> {
    let output = taskkill_owned_process_tree_command(pid)
        .output()
        .map_err(|error| format!("failed to run taskkill for owned process tree: {error}"))?;
    if output.status.success() {
        return Ok(());
    }
    let stderr = String::from_utf8_lossy(&output.stderr).trim().to_string();
    let stdout = String::from_utf8_lossy(&output.stdout).trim().to_string();
    Err(if stderr.is_empty() { stdout } else { stderr })
}

#[cfg(any(windows, test))]
fn taskkill_owned_process_tree_command(pid: u32) -> Command {
    let mut command = Command::new("taskkill");
    command
        .args(taskkill_process_tree_args(pid))
        .stdin(Stdio::null());
    command
}

#[cfg(any(windows, test))]
fn taskkill_process_tree_args(pid: u32) -> [String; 4] {
    ["/PID".into(), pid.to_string(), "/T".into(), "/F".into()]
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn taskkill_command_targets_only_spawned_pid_tree() {
        let command = taskkill_owned_process_tree_command(4242);
        let args: Vec<String> = command
            .get_args()
            .map(|argument| argument.to_string_lossy().into_owned())
            .collect();

        assert_eq!(command.get_program().to_string_lossy(), "taskkill");
        assert_eq!(args, vec!["/PID", "4242", "/T", "/F"]);
        assert!(!args.iter().any(|argument| argument == "/IM"));
    }
}
