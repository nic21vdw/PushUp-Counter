export function isPrivateAddress(address) {
  const ip = String(address ?? "")
    .toLowerCase()
    .replace(/^::ffff:/, "");
  if (ip === "::1" || /^127\./.test(ip)) return true;
  if (/^10\./.test(ip) || /^192\.168\./.test(ip)) return true;
  if (/^172\.(1[6-9]|2\d|3[01])\./.test(ip)) return true;
  if (/^169\.254\./.test(ip)) return true;
  return /^f[cd][0-9a-f]{2}:/.test(ip) || /^fe80:/.test(ip);
}
