use which::which;

/// Rebuild the eBPF programs whenever bpf-linker changes (it has no other way of
/// telling cargo that the linker is part of the build).
fn main() {
    let bpf_linker = which("bpf-linker").expect("bpf-linker not found in PATH");
    println!("cargo:rerun-if-changed={}", bpf_linker.display());
}
