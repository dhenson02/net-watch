//! Minimal BTF reader used to resolve kernel struct member offsets at startup.
//!
//! Aya's Rust eBPF programs have no CO-RE field relocations, so instead of
//! compiling fixed offsets into the program we look them up in the running
//! kernel's `/sys/kernel/btf/vmlinux` and inject them as read-only globals.

use std::collections::HashMap;

use anyhow::{anyhow, bail, Context as _, Result};

use net_watch_common::{Offsets, SK_BLOCK};

const KIND_INT: u32 = 1;
const KIND_ARRAY: u32 = 3;
const KIND_STRUCT: u32 = 4;
const KIND_UNION: u32 = 5;
const KIND_ENUM: u32 = 6;
const KIND_TYPEDEF: u32 = 8;
const KIND_VOLATILE: u32 = 9;
const KIND_CONST: u32 = 10;
const KIND_RESTRICT: u32 = 11;
const KIND_FUNC_PROTO: u32 = 13;
const KIND_VAR: u32 = 14;
const KIND_DATASEC: u32 = 15;
const KIND_DECL_TAG: u32 = 17;
const KIND_TYPE_TAG: u32 = 18;
const KIND_ENUM64: u32 = 19;

struct Member {
    name: u32,
    ty: u32,
    bit_off: u32,
}

struct Type {
    name: u32,
    kind: u32,
    /// `ref_type` for modifiers/typedefs; unused otherwise.
    ty: u32,
    members: Vec<Member>,
    enums: Vec<(u32, i64)>,
}

pub struct Btf {
    /// Index 0 is the implicit `void` type.
    types: Vec<Type>,
    strings: Vec<u8>,
    by_name: HashMap<(String, u32), u32>,
}

impl Btf {
    pub fn from_sys_fs() -> Result<Self> {
        let data = std::fs::read("/sys/kernel/btf/vmlinux")
            .context("reading /sys/kernel/btf/vmlinux (kernel needs CONFIG_DEBUG_INFO_BTF)")?;
        Self::parse(&data)
    }

    fn parse(d: &[u8]) -> Result<Self> {
        let u16_at = |o: usize| u16::from_le_bytes([d[o], d[o + 1]]);
        let u32_at = |o: usize| u32::from_le_bytes(d[o..o + 4].try_into().unwrap());
        if d.len() < 24 || u16_at(0) != 0xeb9f {
            bail!("not a little-endian BTF blob");
        }
        let hdr_len = u32_at(4) as usize;
        let (type_off, type_len) = (u32_at(8) as usize, u32_at(12) as usize);
        let (str_off, str_len) = (u32_at(16) as usize, u32_at(20) as usize);
        let strings = d[hdr_len + str_off..hdr_len + str_off + str_len].to_vec();

        let mut types = vec![Type { name: 0, kind: 0, ty: 0, members: vec![], enums: vec![] }];
        let mut p = hdr_len + type_off;
        let end = p + type_len;
        while p < end {
            let name = u32_at(p);
            let info = u32_at(p + 4);
            let size_or_type = u32_at(p + 8);
            p += 12;
            let vlen = (info & 0xffff) as usize;
            let kind = (info >> 24) & 0x1f;
            let kind_flag = info >> 31 == 1;
            let mut t = Type { name, kind, ty: size_or_type, members: vec![], enums: vec![] };
            match kind {
                KIND_INT | KIND_VAR | KIND_DECL_TAG => p += 4,
                KIND_ARRAY => p += 12,
                KIND_STRUCT | KIND_UNION => {
                    for i in 0..vlen {
                        let o = p + i * 12;
                        let off = u32_at(o + 8);
                        t.members.push(Member {
                            name: u32_at(o),
                            ty: u32_at(o + 4),
                            // With kind_flag the high byte holds the bitfield size.
                            bit_off: if kind_flag { off & 0x00ff_ffff } else { off },
                        });
                    }
                    p += vlen * 12;
                }
                KIND_ENUM => {
                    for i in 0..vlen {
                        let o = p + i * 8;
                        t.enums.push((u32_at(o), u32_at(o + 4) as i32 as i64));
                    }
                    p += vlen * 8;
                }
                KIND_ENUM64 => {
                    for i in 0..vlen {
                        let o = p + i * 12;
                        let v = (u32_at(o + 8) as u64) << 32 | u32_at(o + 4) as u64;
                        t.enums.push((u32_at(o), v as i64));
                    }
                    p += vlen * 12;
                }
                KIND_FUNC_PROTO => p += vlen * 8,
                KIND_DATASEC => p += vlen * 12,
                _ => {}
            }
            types.push(t);
        }

        let mut btf = Btf { types, strings, by_name: HashMap::new() };
        for id in 1..btf.types.len() as u32 {
            let t = &btf.types[id as usize];
            if matches!(t.kind, KIND_STRUCT | KIND_UNION | KIND_ENUM | KIND_ENUM64) && t.name != 0 {
                let key = (btf.str(t.name).to_owned(), t.kind);
                // Keep the first definition; duplicates in vmlinux are identical.
                btf.by_name.entry(key).or_insert(id);
            }
        }
        Ok(btf)
    }

    fn str(&self, off: u32) -> &str {
        let s = &self.strings[off as usize..];
        let n = s.iter().position(|&b| b == 0).unwrap_or(s.len());
        std::str::from_utf8(&s[..n]).unwrap_or("")
    }

    fn skip_modifiers(&self, mut id: u32) -> u32 {
        loop {
            let t = &self.types[id as usize];
            match t.kind {
                KIND_TYPEDEF | KIND_VOLATILE | KIND_CONST | KIND_RESTRICT | KIND_TYPE_TAG => id = t.ty,
                _ => return id,
            }
        }
    }

    /// Byte offset of `member` in `struct name`, descending into anonymous
    /// structs/unions the way C name lookup does.
    pub fn offset(&self, struct_name: &str, member: &str) -> Result<u32> {
        let id = self
            .by_name
            .get(&(struct_name.to_owned(), KIND_STRUCT))
            .copied()
            .ok_or_else(|| anyhow!("struct {struct_name} not found in kernel BTF"))?;
        let bits = self
            .find_member(id, member)
            .ok_or_else(|| anyhow!("{struct_name}.{member} not found in kernel BTF"))?;
        if bits % 8 != 0 {
            bail!("{struct_name}.{member} is a bitfield");
        }
        Ok(bits / 8)
    }

    fn find_member(&self, id: u32, member: &str) -> Option<u32> {
        for m in &self.types[id as usize].members {
            if m.name != 0 {
                if self.str(m.name) == member {
                    return Some(m.bit_off);
                }
                continue;
            }
            let inner = self.skip_modifiers(m.ty);
            if matches!(self.types[inner as usize].kind, KIND_STRUCT | KIND_UNION) {
                if let Some(off) = self.find_member(inner, member) {
                    return Some(m.bit_off + off);
                }
            }
        }
        None
    }

    pub fn enum_value(&self, enum_name: &str, variant: &str) -> Result<i64> {
        let id = self
            .by_name
            .get(&(enum_name.to_owned(), KIND_ENUM))
            .or_else(|| self.by_name.get(&(enum_name.to_owned(), KIND_ENUM64)))
            .copied()
            .ok_or_else(|| anyhow!("enum {enum_name} not found in kernel BTF"))?;
        self.types[id as usize]
            .enums
            .iter()
            .find(|(n, _)| self.str(*n) == variant)
            .map(|(_, v)| *v)
            .ok_or_else(|| anyhow!("{enum_name}::{variant} not found in kernel BTF"))
    }
}

/// Resolves every offset the eBPF programs need. Payload sniffing is disabled
/// (rather than failing) if the kernel's `iov_iter` layout is not the expected one.
pub fn resolve_offsets(btf: &Btf, sniff: bool) -> Result<Offsets> {
    let common = btf.offset("sock", "__sk_common")?;
    // (offset within struct sock, field size)
    let fields = [
        (common + btf.offset("sock_common", "skc_daddr")?, 4),
        (common + btf.offset("sock_common", "skc_dport")?, 2),
        (common + btf.offset("sock_common", "skc_num")?, 2),
        (common + btf.offset("sock_common", "skc_family")?, 2),
        (common + btf.offset("sock_common", "skc_v6_daddr")?, 16),
    ];
    let base = fields.iter().map(|f| f.0).min().unwrap();
    let span = fields.iter().map(|f| f.0 + f.1).max().unwrap() - base;
    if span as usize > SK_BLOCK {
        bail!("struct sock_common fields span {span} bytes, more than SK_BLOCK={SK_BLOCK}");
    }

    let mut o = Offsets {
        sk_base: base,
        skc_daddr: fields[0].0 - base,
        skc_dport: fields[1].0 - base,
        skc_num: fields[2].0 - base,
        skc_family: fields[3].0 - base,
        skc_v6_daddr: fields[4].0 - base,
        task_group_leader: btf.offset("task_struct", "group_leader")?,
        task_comm: btf.offset("task_struct", "comm")?,
        task_start_boottime: btf.offset("task_struct", "start_boottime")?,
        msghdr_name: btf.offset("msghdr", "msg_name")?,
        self_tgid: std::process::id(),
        ..Default::default()
    };

    if sniff {
        let iter = (|| -> Result<_> {
            Ok((
                btf.offset("msghdr", "msg_iter")?,
                btf.offset("iov_iter", "iter_type")?,
                btf.offset("iov_iter", "ubuf")?,
                btf.enum_value("iter_type", "ITER_UBUF")?,
            ))
        })();
        match iter {
            Ok((msg_iter, iter_type, ubuf, ubuf_val)) => {
                o.msghdr_iter = msg_iter;
                o.iter_type = iter_type;
                o.iter_ubuf = ubuf;
                o.iter_ubuf_val = ubuf_val as u32;
                o.sniff = 1;
            }
            Err(e) => log::warn!("payload sniffing disabled: {e:#}"),
        }
    }
    Ok(o)
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Runs against the live kernel; sanity-checks well-known stable layouts.
    #[test]
    fn resolves_running_kernel() {
        let Ok(btf) = Btf::from_sys_fs() else { return };
        let o = resolve_offsets(&btf, true).unwrap();
        assert_eq!(o.sk_base, 0);
        assert_eq!(o.skc_daddr, 0);
        assert_eq!(o.skc_dport, 12);
        assert_eq!(o.skc_num, 14);
        assert_eq!(o.skc_family, 16);
        assert_eq!(btf.offset("msghdr", "msg_name").unwrap(), 0);
        assert_eq!(o.sniff, 1);
    }
}
