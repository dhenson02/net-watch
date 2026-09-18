use anyhow::{anyhow, Context as _};
use aya_build::{Package, Toolchain};

fn main() -> anyhow::Result<()> {
    let cargo_metadata::Metadata { packages, .. } = cargo_metadata::MetadataCommand::new()
        .no_deps()
        .exec()
        .context("MetadataCommand::exec")?;
    let ebpf_package = packages
        .into_iter()
        .find(|cargo_metadata::Package { name, .. }| name.as_str() == "net-watch-ebpf")
        .ok_or_else(|| anyhow!("net-watch-ebpf package not found"))?;
    let root_dir = ebpf_package
        .manifest_path
        .parent()
        .ok_or_else(|| anyhow!("no parent for {}", ebpf_package.manifest_path))?;
    aya_build::build_ebpf(
        [Package {
            name: "net-watch-ebpf",
            root_dir: root_dir.as_str(),
            ..Default::default()
        }],
        Toolchain::default(),
    )
}
