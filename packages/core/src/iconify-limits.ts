/** Bound decompressed remote bodies independently of server-supplied headers. */
export const ICONIFY_BODY_MAX_BYTES = 25 * 1024 * 1024

/** JSON string escaping can double a valid body; leave room for metadata. */
export const ICONIFY_CACHE_MAX_BYTES = 2 * ICONIFY_BODY_MAX_BYTES + 64 * 1024
