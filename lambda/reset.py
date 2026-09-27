"""Hourly reset of the public demo.

Brings the wiki back to a fresh deployment: every tiddler, revision, open
story and draft is removed from DynamoDB, every attached file (all versions)
from S3, and every Cognito user except the demo administrator, whose password,
state and admin rights are put back.

The example tiddlers in tiddlers.json (seed/ in the repository) are then
written again. Their files live under files/seed/, are uploaded by Terraform
and are never removed here.
"""

import json
import logging
import os

logger = logging.getLogger()
logger.setLevel(logging.INFO)

_clients = {}

SEED_PREFIX = "files/seed/"
SEED_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "tiddlers.json")


def client(name):
    if name not in _clients:
        import boto3

        _clients[name] = boto3.client(name)
    return _clients[name]


def handler(event, context):
    result = {
        "items": wipe_table(os.environ["TABLE_NAME"]),
        "seeded": seed_table(os.environ["TABLE_NAME"], os.environ["ADMIN_EMAIL"]),
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
        write(table, [{"DeleteRequest": {"Key": key}} for key in keys])
        removed += len(keys)
        if not page.get("LastEvaluatedKey"):
            return removed
        kwargs["ExclusiveStartKey"] = page["LastEvaluatedKey"]


def write(table, requests):
    for start in range(0, len(requests), 25):
        batch = requests[start:start + 25]
        while batch:
            answer = client("dynamodb").batch_write_item(RequestItems={table: batch})
            batch = answer.get("UnprocessedItems", {}).get(table, [])


def seed_table(table, author):
    """Writes the example tiddlers as if the administrator had just created them."""
    if not os.path.exists(SEED_FILE):
        return 0
    import lambda_app

    with open(SEED_FILE, encoding="utf-8") as source:
        tiddlers = json.load(source)
    now = lambda_app.now_iso()
    requests = []
    for tiddler in tiddlers:
        item = lambda_app.current_item(
            tiddler["title"], tiddler["text"], tiddler.get("tags", []),
            tiddler.get("type", lambda_app.DEFAULT_TYPE), now, author, now, author,
        )
        for row in (item, lambda_app.revision_item(item, "create", now, author)):
            requests.append({"PutRequest": {"Item": lambda_app.marshal_item(row)}})
    write(table, requests)
    return len(tiddlers)


def wipe_bucket(bucket):
    """Deletes every version and delete marker, so nothing stays recoverable.

    The example files under SEED_PREFIX stay: Terraform uploads them once.
    """
    removed = 0
    paginator = client("s3").get_paginator("list_object_versions")
    for page in paginator.paginate(Bucket=bucket):
        objects = [
            {"Key": item["Key"], "VersionId": item["VersionId"]}
            for item in page.get("Versions", []) + page.get("DeleteMarkers", [])
            if not item["Key"].startswith(SEED_PREFIX)
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
