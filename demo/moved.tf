# The demo kept its resources at the top of the state until the repository
# became a module (v1.6.0): its state keeps every resource, now under
# module.wiki. The CloudFront key of the attachments is made only without
# files_key_from, and the resources of the reset only with a reset_schedule,
# so they have an index there.

moved {
  from = aws_cloudwatch_log_delivery_source.access
  to   = module.wiki.aws_cloudwatch_log_delivery_source.access
}

moved {
  from = aws_cloudwatch_log_delivery_destination.access
  to   = module.wiki.aws_cloudwatch_log_delivery_destination.access
}

moved {
  from = aws_cloudwatch_log_delivery.access
  to   = module.wiki.aws_cloudwatch_log_delivery.access
}

moved {
  from = aws_apigatewayv2_api.http
  to   = module.wiki.aws_apigatewayv2_api.http
}

moved {
  from = aws_apigatewayv2_authorizer.cognito
  to   = module.wiki.aws_apigatewayv2_authorizer.cognito
}

moved {
  from = aws_apigatewayv2_integration.lambda
  to   = module.wiki.aws_apigatewayv2_integration.lambda
}

moved {
  from = aws_apigatewayv2_route.api
  to   = module.wiki.aws_apigatewayv2_route.api
}

moved {
  from = aws_cloudwatch_log_group.api
  to   = module.wiki.aws_cloudwatch_log_group.api
}

moved {
  from = aws_apigatewayv2_stage.default
  to   = module.wiki.aws_apigatewayv2_stage.default
}

moved {
  from = aws_lambda_permission.api
  to   = module.wiki.aws_lambda_permission.api
}

moved {
  from = tls_private_key.files
  to   = module.wiki.tls_private_key.files[0]
}

moved {
  from = aws_cloudfront_public_key.files
  to   = module.wiki.aws_cloudfront_public_key.files[0]
}

moved {
  from = aws_cloudfront_key_group.files
  to   = module.wiki.aws_cloudfront_key_group.files[0]
}

moved {
  from = aws_ssm_parameter.files_signing_key
  to   = module.wiki.aws_ssm_parameter.files_signing_key[0]
}

moved {
  from = aws_cloudfront_function.api_host
  to   = module.wiki.aws_cloudfront_function.api_host
}

moved {
  from = aws_cloudfront_cache_policy.files
  to   = module.wiki.aws_cloudfront_cache_policy.files
}

moved {
  from = aws_cloudfront_response_headers_policy.files
  to   = module.wiki.aws_cloudfront_response_headers_policy.files
}

moved {
  from = aws_cloudfront_origin_access_control.web
  to   = module.wiki.aws_cloudfront_origin_access_control.web
}

moved {
  from = aws_cloudfront_cache_policy.web
  to   = module.wiki.aws_cloudfront_cache_policy.web
}

moved {
  from = aws_cloudfront_response_headers_policy.web
  to   = module.wiki.aws_cloudfront_response_headers_policy.web
}

moved {
  from = aws_cloudfront_distribution.web
  to   = module.wiki.aws_cloudfront_distribution.web
}

moved {
  from = aws_cognito_user_pool.main
  to   = module.wiki.aws_cognito_user_pool.main
}

moved {
  from = aws_cognito_user_pool_client.web
  to   = module.wiki.aws_cognito_user_pool_client.web
}

moved {
  from = aws_cognito_user.admin
  to   = module.wiki.aws_cognito_user.admin
}

moved {
  from = aws_cognito_user_group.admins
  to   = module.wiki.aws_cognito_user_group.admins
}

moved {
  from = aws_cognito_user_in_group.admin
  to   = module.wiki.aws_cognito_user_in_group.admin
}

moved {
  from = aws_dynamodb_table.tiddlers
  to   = module.wiki.aws_dynamodb_table.tiddlers
}

moved {
  from = aws_s3_object.web
  to   = module.wiki.aws_s3_object.web
}

moved {
  from = aws_s3_object.config
  to   = module.wiki.aws_s3_object.config
}

moved {
  from = aws_iam_role.lambda
  to   = module.wiki.aws_iam_role.lambda
}

moved {
  from = aws_iam_role_policy.lambda
  to   = module.wiki.aws_iam_role_policy.lambda
}

moved {
  from = aws_cloudwatch_log_group.lambda
  to   = module.wiki.aws_cloudwatch_log_group.lambda
}

moved {
  from = aws_lambda_function.api
  to   = module.wiki.aws_lambda_function.api
}

moved {
  from = aws_ssm_parameter.admin_password
  to   = module.wiki.aws_ssm_parameter.admin_password[0]
}

moved {
  from = aws_cloudwatch_log_group.reset
  to   = module.wiki.aws_cloudwatch_log_group.reset[0]
}

moved {
  from = aws_iam_role.reset
  to   = module.wiki.aws_iam_role.reset[0]
}

moved {
  from = aws_iam_role_policy.reset
  to   = module.wiki.aws_iam_role_policy.reset[0]
}

moved {
  from = aws_lambda_function.reset
  to   = module.wiki.aws_lambda_function.reset[0]
}

moved {
  from = aws_cloudwatch_event_rule.reset
  to   = module.wiki.aws_cloudwatch_event_rule.reset
}

moved {
  from = aws_cloudwatch_event_target.reset
  to   = module.wiki.aws_cloudwatch_event_target.reset
}

moved {
  from = aws_lambda_permission.reset
  to   = module.wiki.aws_lambda_permission.reset
}

moved {
  from = aws_s3_bucket.web
  to   = module.wiki.aws_s3_bucket.web
}

moved {
  from = aws_s3_bucket_public_access_block.web
  to   = module.wiki.aws_s3_bucket_public_access_block.web
}

moved {
  from = aws_s3_bucket_ownership_controls.web
  to   = module.wiki.aws_s3_bucket_ownership_controls.web
}

moved {
  from = aws_s3_bucket_versioning.web
  to   = module.wiki.aws_s3_bucket_versioning.web
}

moved {
  from = aws_s3_bucket_server_side_encryption_configuration.web
  to   = module.wiki.aws_s3_bucket_server_side_encryption_configuration.web
}

moved {
  from = aws_s3_bucket_lifecycle_configuration.web
  to   = module.wiki.aws_s3_bucket_lifecycle_configuration.web
}

moved {
  from = aws_s3_bucket_policy.web
  to   = module.wiki.aws_s3_bucket_policy.web
}

moved {
  from = aws_s3_bucket.files
  to   = module.wiki.aws_s3_bucket.files
}

moved {
  from = aws_s3_bucket_public_access_block.files
  to   = module.wiki.aws_s3_bucket_public_access_block.files
}

moved {
  from = aws_s3_bucket_ownership_controls.files
  to   = module.wiki.aws_s3_bucket_ownership_controls.files
}

moved {
  from = aws_s3_bucket_versioning.files
  to   = module.wiki.aws_s3_bucket_versioning.files
}

moved {
  from = aws_s3_bucket_server_side_encryption_configuration.files
  to   = module.wiki.aws_s3_bucket_server_side_encryption_configuration.files
}

moved {
  from = aws_s3_bucket_cors_configuration.files
  to   = module.wiki.aws_s3_bucket_cors_configuration.files
}

moved {
  from = aws_s3_bucket_policy.files
  to   = module.wiki.aws_s3_bucket_policy.files
}

moved {
  from = aws_s3_bucket_lifecycle_configuration.files
  to   = module.wiki.aws_s3_bucket_lifecycle_configuration.files
}

moved {
  from = aws_s3_object.seed
  to   = module.wiki.aws_s3_object.seed
}
