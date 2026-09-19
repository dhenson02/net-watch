// SQL fragments shared by the history queries. They are constants: user input
// never becomes SQL text, only `{name:Type}` parameters.

/**
 * `raddr` as text, matching the plain IPv4 that Redis and the live API show
 * (IPv4 is stored IPv4-mapped, `::ffff:a.b.c.d`). For the reverse direction,
 * filtering by user-typed text, use `raddr = toIPv6({ip:String})`: toIPv6 maps
 * IPv4 input to `::ffff:…`.
 */
export const DISPLAY_IP = "replaceRegexpOne(IPv6NumToString(raddr), '^::ffff:(\\d+\\.\\d+\\.\\d+\\.\\d+)$', '\\1')";
