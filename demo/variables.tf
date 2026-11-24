variable "region" {
  type        = string
  default     = "eu-central-1"
  description = "Region of every resource but CloudFront: the API, the data, the files and the sign-in."
}

# The CI reads this default: a preview of a pull request is <name>-pr<N>.
variable "name" {
  type        = string
  default     = "wiki-serverless"
  description = "Prefix of every resource name; bucket names add the account id. The deploy role of the demo is limited to it."
}

variable "access_logs_bucket" {
  type        = string
  default     = ""
  description = "Bucket that the access logs of the demo go to (the repository variable ACCESS_LOGS_BUCKET in CI). Empty: no access logs."
}

variable "files_key_from" {
  type        = string
  default     = null
  description = "Name of a deployed stack whose CloudFront key signs the attachment cookies; unset, a preview uses the key of the main demo."
}

variable "tags" {
  type = map(string)
  default = {
    Managed = "IAC"
    Project = "wiki-serverless-aws"
  }
  description = "Tags applied to supported resources."
}
