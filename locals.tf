locals {
  name         = var.name
  account_id   = data.aws_caller_identity.current.account_id
  region       = data.aws_region.current.region
  web_bucket   = "${local.name}-web-${local.account_id}"
  files_bucket = "${local.name}-files-${local.account_id}"
  # A preview signs file cookies with the key of the site it previews.
  files_key_from = var.files_key_from != null ? var.files_key_from : try(regex("^(.+)-pr[0-9]+$", var.name)[0], "")
  own_files_key  = local.files_key_from == ""
  # Exactly one of the lists has an element. A conditional would not do:
  # both of its sides are evaluated, and the one left out is empty.
  files_key = one(concat(
    [for index, group in aws_cloudfront_key_group.files : {
      key_group_id          = group.id
      public_key_id         = aws_cloudfront_public_key.files[index].id
      private_key_parameter = aws_ssm_parameter.files_signing_key[index].name
    }],
    # Ids and a parameter name; the data source marks every value sensitive.
    [for parameter in data.aws_ssm_parameter.shared_files_key : jsondecode(nonsensitive(parameter.value))],
  ))

  # The wiki on its own domain, or on the CloudFront address without one.
  custom_domain = var.domain_name != ""
  site_host     = local.custom_domain ? var.domain_name : aws_cloudfront_distribution.web.domain_name
  site_url      = "https://${local.site_host}"

  reset = var.reset_delay_hours > 0

  # The version of this deployment: the newest entry of CHANGELOG.md
  # (## vX.Y.Z, then optionally " — " and a date or a title). After main is
  # deployed, CI tags and releases it on GitHub.
  version = regex("(?m)^## (v[0-9]+\\.[0-9]+\\.[0-9]+)(?:\\s|$)", file("${path.module}/CHANGELOG.md"))[0]

  csp = join("; ", [
    "default-src 'self'",
    "script-src 'self' https://cdn.jsdelivr.net",
    "style-src 'self'",
    "img-src 'self' blob: data: https:",
    "media-src 'self'",
    "connect-src 'self' https://cognito-idp.${local.region}.amazonaws.com https://*.s3.${local.region}.amazonaws.com https://*.s3.amazonaws.com",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ])
  # Attached files are served from the site origin. The sandbox keeps an
  # uploaded HTML or SVG file from running script with the wiki's cookies.
  files_csp = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; media-src 'self'; sandbox"
}
