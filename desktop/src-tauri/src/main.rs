// Prevents an additional console window on Windows in release builds.
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    g_code_desktop_lib::run_model_check_if_requested();
    g_code_desktop_lib::run()
}
