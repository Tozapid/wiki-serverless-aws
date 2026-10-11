resource "aws_dynamodb_table" "tiddlers" {
  #checkov:skip=CKV_AWS_119:An AWS owned key avoids a dedicated KMS charge on this account.
  name         = local.name
  billing_mode = "PAY_PER_REQUEST"
  hash_key     = "pk"
  range_key    = "sk"

  attribute {
    name = "pk"
    type = "S"
  }

  attribute {
    name = "sk"
    type = "S"
  }

  attribute {
    name = "gsi1pk"
    type = "S"
  }

  attribute {
    name = "gsi1sk"
    type = "S"
  }

  global_secondary_index {
    name = "tiddlers"
    # key_schema in place of hash_key and range_key, deprecated in the index.
    key_schema {
      attribute_name = "gsi1pk"
      key_type       = "HASH"
    }
    key_schema {
      attribute_name = "gsi1sk"
      key_type       = "RANGE"
    }
    # Everything but the text: the page lists tiddlers at sign-in and loads a
    # text only when that tiddler is opened.
    projection_type    = "INCLUDE"
    non_key_attributes = ["title", "tags", "type", "created", "creator", "modified", "modifier", "etag", "links", "size"]
  }

  point_in_time_recovery {
    enabled = true
  }

  server_side_encryption {
    enabled = true
  }
}
