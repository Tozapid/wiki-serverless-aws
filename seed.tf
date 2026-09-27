# Example files of the demo. The hourly reset writes the tiddlers from
# seed/tiddlers.json again and leaves files/seed/ alone; the API's cleanup of
# unused files skips it too. A private wiki without a reset gets neither.

locals {
  seed_types = {
    jpg  = "image/jpeg"
    jpeg = "image/jpeg"
    png  = "image/png"
    webp = "image/webp"
    gif  = "image/gif"
    mp4  = "video/mp4"
    webm = "video/webm"
  }
  seed_files = var.reset_schedule == "" ? toset([]) : fileset("${path.module}/seed/files", "*")
}

resource "aws_s3_object" "seed" {
  for_each = local.seed_files

  bucket       = aws_s3_bucket.files.id
  key          = "files/seed/${each.value}"
  source       = "${path.module}/seed/files/${each.value}"
  source_hash  = filemd5("${path.module}/seed/files/${each.value}")
  content_type = lookup(local.seed_types, lower(regex("[^.]+$", each.value)), "application/octet-stream")
}
