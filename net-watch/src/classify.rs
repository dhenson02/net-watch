//! Application-protocol labelling from ports plus a few payload signatures.

use net_watch_common::{IPPROTO_TCP, IPPROTO_UDP};

pub fn transport(proto: u8) -> &'static str {
    match proto {
        IPPROTO_TCP => "TCP",
        IPPROTO_UDP => "UDP",
        _ => "OTHER",
    }
}

/// What the first bytes of a TCP send look like, if recognisable.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Sniffed {
    Tls,
    Http,
    Http2,
    Ssh,
}

pub fn sniff(head: &[u8]) -> Option<Sniffed> {
    if head.len() < 4 {
        return None;
    }
    // TLS record: content type 20..=23, version 3.x (SSL3 .. TLS1.3 all use 0x03).
    if (0x14..=0x17).contains(&head[0]) && head[1] == 0x03 && head[2] <= 0x04 {
        return Some(Sniffed::Tls);
    }
    if head.starts_with(b"SSH-") {
        return Some(Sniffed::Ssh);
    }
    if head.starts_with(b"PRI * HT") {
        return Some(Sniffed::Http2);
    }
    const HTTP: &[&[u8]] = &[
        b"GET ", b"POST", b"PUT ", b"HEAD", b"DELE", b"OPTI", b"PATC", b"CONN", b"TRAC", b"HTTP",
    ];
    if HTTP.iter().any(|m| head.starts_with(m)) {
        return Some(Sniffed::Http);
    }
    None
}

fn well_known(proto: u8, port: u16) -> Option<&'static str> {
    let tcp = proto == IPPROTO_TCP;
    Some(match (tcp, port) {
        (true, 20) => "FTP-DATA",
        (true, 21) => "FTP",
        (_, 22) => "SSH",
        (true, 23) => "Telnet",
        (true, 25) | (true, 587) => "SMTP",
        (_, 53) => "DNS",
        (false, 67) | (false, 68) => "DHCP",
        (false, 69) => "TFTP",
        (true, 80) | (true, 8080) | (true, 8000) => "HTTP",
        (true, 110) => "POP3",
        (_, 111) => "RPC",
        (false, 123) => "NTP",
        (_, 137..=139) => "NetBIOS",
        (true, 143) => "IMAP",
        (false, 161) | (false, 162) => "SNMP",
        (true, 179) => "BGP",
        (_, 389) => "LDAP",
        (true, 443) | (true, 8443) => "HTTPS",
        (false, 443) => "QUIC",
        (true, 445) => "SMB",
        (true, 465) => "SMTPS",
        (false, 500) | (false, 4500) => "IPsec",
        (false, 514) => "Syslog",
        (true, 636) => "LDAPS",
        (true, 853) => "DoT",
        (true, 873) => "rsync",
        (true, 990) => "FTPS",
        (true, 993) => "IMAPS",
        (true, 995) => "POP3S",
        (true, 1080) => "SOCKS",
        (_, 1194) => "OpenVPN",
        (true, 1433) => "MSSQL",
        (true, 1521) => "Oracle",
        (true, 1883) | (true, 8883) => "MQTT",
        (false, 1900) => "SSDP",
        (_, 2049) => "NFS",
        (true, 2375) | (true, 2376) => "Docker",
        (true, 3306) => "MySQL",
        (_, 3389) => "RDP",
        (_, 3478) => "STUN",
        (true, 5222) => "XMPP",
        (false, 5353) => "mDNS",
        (false, 5355) => "LLMNR",
        (true, 5432) => "PostgreSQL",
        (true, 5672) => "AMQP",
        (true, 5900..=5903) => "VNC",
        (true, 6379) => "Redis",
        (true, 6443) => "Kubernetes",
        (true, 6667) => "IRC",
        (true, 6881..=6889) | (false, 6881..=6889) => "BitTorrent",
        (true, 8123) => "ClickHouse",
        (true, 9092) => "Kafka",
        (true, 9200) => "Elasticsearch",
        (true, 9418) => "Git",
        (_, 11211) => "Memcached",
        (true, 27017) => "MongoDB",
        (false, 41641) => "Tailscale",
        (false, 51820) => "WireGuard",
        _ => return None,
    })
}

/// Label for a flow. `rport` is tried before `lport` so that clients are
/// labelled by the service they talk to and servers by the one they offer.
pub fn app(proto: u8, rport: u16, lport: u16, sniffed: Option<Sniffed>) -> &'static str {
    let by_port = well_known(proto, rport).or_else(|| well_known(proto, lport));
    match sniffed {
        Some(Sniffed::Ssh) => "SSH",
        Some(Sniffed::Http) => "HTTP",
        Some(Sniffed::Http2) => "HTTP/2",
        // TLS on a port whose protocol is itself TLS-wrapped keeps the specific name.
        Some(Sniffed::Tls) => match by_port {
            Some("HTTP") | Some("HTTPS") => "HTTPS",
            Some(p @ ("IMAPS" | "POP3S" | "SMTPS" | "LDAPS" | "FTPS" | "DoT" | "MQTT"
            | "Kubernetes" | "Docker")) => p,
            _ => "TLS",
        },
        None => by_port.unwrap_or("unknown"),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn labels() {
        assert_eq!(app(IPPROTO_TCP, 443, 50123, None), "HTTPS");
        assert_eq!(app(IPPROTO_UDP, 443, 50123, None), "QUIC");
        assert_eq!(app(IPPROTO_TCP, 50123, 22, None), "SSH");
        assert_eq!(app(IPPROTO_TCP, 9999, 50123, sniff(&[0x16, 3, 1, 0, 0xa5, 1, 0, 0])), "TLS");
        assert_eq!(app(IPPROTO_TCP, 80, 50123, sniff(&[0x16, 3, 3, 0, 0, 0, 0, 0])), "HTTPS");
        assert_eq!(app(IPPROTO_TCP, 3000, 50123, sniff(b"GET / HT")), "HTTP");
        assert_eq!(app(IPPROTO_TCP, 2222, 50123, sniff(b"SSH-2.0-")), "SSH");
        assert_eq!(app(IPPROTO_TCP, 40000, 50123, None), "unknown");
    }
}
