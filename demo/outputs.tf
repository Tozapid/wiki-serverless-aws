# The CI writes site_url into the summary of a deploy and the comment of a
# preview.
output "site_url" {
  description = "Address of the wiki."
  value       = module.wiki.site_url
}

output "cloudfront_url" {
  description = "CloudFront address of the wiki."
  value       = module.wiki.cloudfront_url
}

output "admin_username" {
  description = "Sign-in of the demo administrator."
  value       = module.wiki.admin_username
}
