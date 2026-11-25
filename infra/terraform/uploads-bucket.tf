resource "aws_s3_bucket" "uploads" {
  # checkov:skip=CKV_AWS_18:Access is through the task role only and is recorded by CloudTrail; server access logs would duplicate it.
  # checkov:skip=CKV_AWS_144:A second-region copy of client files is a data-residency decision for the operator, not a default.
  # checkov:skip=CKV2_AWS_62:No consumer for event notifications; the app reads and writes the files itself.
  count = var.uploads_bucket_enabled ? 1 : 0

  bucket        = coalesce(var.uploads_bucket_name, "${local.name}-uploads-${local.account_id}")
  force_destroy = false
}

resource "aws_s3_bucket_ownership_controls" "uploads" {
  count = var.uploads_bucket_enabled ? 1 : 0

  bucket = aws_s3_bucket.uploads[0].id

  rule {
    object_ownership = "BucketOwnerEnforced"
  }
}

resource "aws_s3_bucket_public_access_block" "uploads" {
  count = var.uploads_bucket_enabled ? 1 : 0

  bucket                  = aws_s3_bucket.uploads[0].id
  block_public_acls       = true
  block_public_policy     = true
  ignore_public_acls      = true
  restrict_public_buckets = true
}

resource "aws_s3_bucket_versioning" "uploads" {
  count = var.uploads_bucket_enabled ? 1 : 0

  bucket = aws_s3_bucket.uploads[0].id

  versioning_configuration {
    status = "Enabled"
  }
}

resource "aws_s3_bucket_server_side_encryption_configuration" "uploads" {
  count = var.uploads_bucket_enabled ? 1 : 0

  bucket = aws_s3_bucket.uploads[0].id

  rule {
    apply_server_side_encryption_by_default {
      sse_algorithm     = "aws:kms"
      kms_master_key_id = aws_kms_key.app.arn
    }
    bucket_key_enabled = true
  }
}

resource "aws_s3_bucket_lifecycle_configuration" "uploads" {
  count = var.uploads_bucket_enabled ? 1 : 0

  bucket = aws_s3_bucket.uploads[0].id

  rule {
    id     = "keep-replaced-and-deleted-files-for-a-while"
    status = "Enabled"

    filter {}

    noncurrent_version_expiration {
      noncurrent_days = var.uploads_noncurrent_version_days
    }

    abort_incomplete_multipart_upload {
      days_after_initiation = 1
    }
  }

  depends_on = [aws_s3_bucket_versioning.uploads]
}

data "aws_iam_policy_document" "uploads_bucket" {
  count = var.uploads_bucket_enabled ? 1 : 0

  statement {
    sid       = "DenyInsecureTransport"
    effect    = "Deny"
    actions   = ["s3:*"]
    resources = [aws_s3_bucket.uploads[0].arn, "${aws_s3_bucket.uploads[0].arn}/*"]

    principals {
      type        = "AWS"
      identifiers = ["*"]
    }

    condition {
      test     = "Bool"
      variable = "aws:SecureTransport"
      values   = ["false"]
    }
  }
}

resource "aws_s3_bucket_policy" "uploads" {
  count = var.uploads_bucket_enabled ? 1 : 0

  bucket = aws_s3_bucket.uploads[0].id
  policy = data.aws_iam_policy_document.uploads_bucket[0].json

  depends_on = [aws_s3_bucket_public_access_block.uploads]
}
