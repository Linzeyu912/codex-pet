#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    if codex_pet_lib::handle_notify_arguments(std::env::args_os()) {
        return;
    }
    codex_pet_lib::run();
}
