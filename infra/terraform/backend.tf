terraform {
  backend "s3" {
    bucket       = "nopal-grc-tfstate-037022143837"
    key          = "isms/production/terraform.tfstate"
    region       = "ap-south-1"
    encrypt      = true
    use_lockfile = true
  }
}
