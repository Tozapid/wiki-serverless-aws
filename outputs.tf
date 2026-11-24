output "site_url" {
  description = "Address of the wiki."
  value       = local.site_url
}

output "cloudfront_url" {
  description = "CloudFront address of the wiki."
  value       = "https://${aws_cloudfront_distribution.web.domain_name}"
}

output "cognito_user_pool_id" {
  description = "Cognito user pool that signs users in."
  value       = aws_cognito_user_pool.main.id
}

output "cognito_client_id" {
  description = "Public app client id used by the browser."
  value       = aws_cognito_user_pool_client.web.id
}

output "admin_username" {
  description = "Email of the first user, an administrator."
  value       = var.admin_email
}

output "function_name" {
  description = "Lambda function of the API."
  value       = aws_lambda_function.api.function_name
}
