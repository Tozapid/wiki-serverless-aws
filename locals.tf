locals {
  name         = var.name
  account_id   = data.aws_caller_identity.current.account_id
  web_bucket   = "${var.name}-web-${local.account_id}"
  files_bucket = "${var.name}-files-${local.account_id}"
  csp = join("; ", [
    "default-src 'self'",
    "script-src 'self' https://cdn.jsdelivr.net",
    "style-src 'self'",
    "img-src 'self' blob: data: https:",
    "media-src 'self'",
    "connect-src 'self' https://cognito-idp.${var.region}.amazonaws.com https://*.s3.${var.region}.amazonaws.com https://*.s3.amazonaws.com",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ])
  # Attached files are served from the site origin. The sandbox keeps an
  # uploaded HTML or SVG file from running script with the wiki's cookies.
  files_csp = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; media-src 'self'; sandbox"
}
