"""Hourly reset of the public demo.

Brings the wiki back to a fresh deployment: every tiddler, revision, open
story and draft is removed from DynamoDB, every attached file (all versions)
from S3, and every Cognito user except the demo administrator, whose password,
state and admin rights are put back.
"""

import logging
import os

logger = logging.getLogger()
logger.setLevel(logging.INFO)

_clients = {}


def client(name):
    if name not in _clients:
        import boto3

        _clients[name] = boto3.client(name)
    return _clients[name]


def handler(event, context):
    result = {
        "items": wipe_table(os.environ["TABLE_NAME"]),
        "files": wipe_bucket(os.environ["FILES_BUCKET"]),
        "users": reset_users(
            os.environ["USER_POOL_ID"],
            os.environ["ADMIN_EMAIL"],
            os.environ["ADMIN_PASSWORD_PARAMETER"],
            os.environ.get("ADMIN_GROUP", "admins"),
        ),
    }
    logger.info("demo reset: %s", result)
    return result


def wipe_table(table):
    removed = 0
    kwargs = {"TableName": table, "ProjectionExpression": "pk, sk"}
    while True:
        page = client("dynamodb").scan(**kwargs)
        keys = [{"pk": item["pk"], "sk": item["sk"]} for item in page.get("Items", [])]
        for start in range(0, len(keys), 25):
            batch = [{"DeleteRequest": {"Key": key}} for key in keys[start:start + 25]]
            while batch:
                answer = client("dynamodb").batch_write_item(RequestItems={table: batch})
                batch = answer.get("UnprocessedItems", {}).get(table, [])
        removed += len(keys)
        if not page.get("LastEvaluatedKey"):
            return removed
        kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]


def wipe_bucket(bucket):
    """Deletes every version and delete marker, so nothing stays recoverable."""
    removed = 0
    paginator = client("s3").get_paginator("list_object_versions")
    for page in paginator.paginate(Bucket=bucket):
        objects = [
            {"Key": item["Key"], "VersionId": item["VersionId"]}
            for item in page.get("Versions", []) + page.get("DeleteMarkers", [])
        ]
        for start in range(0, len(objects), 1000):
            chunk = objects[start:start + 1000]
            client("s3").delete_objects(Bucket=bucket, Delete={"Objects": chunk, "Quiet": True})
            removed += len(chunk)
    return removed


def reset_users(pool, admin_email, password_parameter, admin_group):
    cognito = client("cognito-idp")
    removed = 0
    admin_found = False
    for page in cognito.get_paginator("list_users").paginate(UserPoolId=pool):
        for user in page.get("Users", []):
            email = next((a["Value"] for a in user.get("Attributes", []) if a["Name"] == "email"), user["Username"])
            if email.lower() == admin_email.lower():
                admin_found = True
                continue
            cognito.admin_delete_user(UserPoolId=pool, Username=user["Username"])
            removed += 1
    password = client("ssm").get_parameter(Name=password_parameter, WithDecryption=True)["Parameter"]["Value"]
    if not admin_found:
        cognito.admin_create_user(
            UserPoolId=pool,
            Username=admin_email,
            UserAttributes=[
                {"Name": "email", "Value": admin_email},
                {"Name": "email_verified", "Value": "true"},
            ],
            MessageAction="SUPPRESS",
        )
    cognito.admin_set_user_password(UserPoolId=pool, Username=admin_email, Password=password, Permanent=True)
    cognito.admin_enable_user(UserPoolId=pool, Username=admin_email)
    cognito.admin_add_user_to_group(UserPoolId=pool, Username=admin_email, GroupName=admin_group)
    # Old sessions end, so nobody keeps editing the wiped wiki from a stale tab.
    cognito.admin_user_global_sign_out(UserPoolId=pool, Username=admin_email)
    return {"removed": removed, "admin_recreated": not admin_found}
