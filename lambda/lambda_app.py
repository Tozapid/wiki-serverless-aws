"""Wiki API.

Every tiddler lives in one DynamoDB table. The current version is SK=CURRENT,
every save, rename and delete is appended as SK=REV#... Attached files stay
private in S3 and are read through CloudFront with a signed cookie.

Each user also has PK=U#<email>: SK=STORY holds the open tiddlers and
SK=DRAFT#<title> an unsaved edit, so both survive a reload on any device.

Members of the Cognito admin group manage users and remove attached files
that no tiddler or draft refers to any more.

The page loads the text of a tiddler only when it is opened. The list it
gets at sign-in comes from the "tiddlers" index, which holds everything but
the text; the links of each tiddler are worked out on save and kept in
"links", so backlinks and missing pages need no text. Full-text search and
the task summary run here instead.
"""

import base64
import hashlib
import json
import logging
import os
import re
import secrets
import string
import time
import uuid
from datetime import datetime, timezone

logger = logging.getLogger()
logger.setLevel(logging.INFO)

TYPES = {"text/vnd.tiddlywiki", "text/markdown", "text/plain"}
DEFAULT_TYPE = "text/vnd.tiddlywiki"
TITLE_MAX = 250
TEXT_MAX_BYTES = 300_000
TAGS_MAX = 50
BODY_MAX = 400_000
REVISIONS_MAX = 100
COOKIE_SECONDS = 3600
STORY_MAX = 200
DRAFTS_MAX = 15
ETAG_RE = re.compile(r"^[0-9a-f]{0,64}$")
SEARCH_MAX = 200
EXTERNAL_RE = re.compile(r"^(https?://|mailto:|/files/)", re.I)
TASK_WIKI_RE = re.compile(r"^((?:>\s?)*[*#]+\s+)\[([ xX])\](?=\s)")
TASK_MARKDOWN_RE = re.compile(r"^(\s*(?:>\s?)*\s*(?:[-+*]|\d+[.)])\s+)\[([ xX])\](?=\s)")
EMAIL_RE = re.compile(r"^[^@\s]{1,64}@[^@\s]{1,190}\.[^@\s]{2,}$")
FILE_GRACE_SECONDS = 3600
PASSWORD_SYMBOLS = "!@#%&*-_=+"
BAD_TITLE_RE = re.compile(r"[\x00-\x1f\x7f\[\]{}|]")
CONTENT_TYPE_RE = re.compile(r"^[A-Za-z0-9][A-Za-z0-9.+-]*/[A-Za-z0-9][A-Za-z0-9.+-]*$")
SHA1_DIGEST_INFO = bytes.fromhex("3021300906052b0e03021a05000414")

_s3 = None
_ddb = None
_table = None
_serializer = None
_signing_key = None
_cognito = None
_resource = None


class ApiError(Exception):
    def __init__(self, status, message, **values):
        super().__init__(message)
        self.status = status
        self.message = message
        self.values = values


def handler(event, context):
    method = event.get("requestContext", {}).get("http", {}).get("method", "GET")
    path = event.get("rawPath") or "/"
    lang = request_language(event)
    try:
        parts = [part for part in path.split("/") if part]
        if not parts or parts[0] != "api":
            raise ApiError(404, "Не найдено")
        result = route(method, parts[1:], event)
    except ApiError as exc:
        result = response(exc.status, {"error": translate(lang, exc.message, exc.values)})
    except json.JSONDecodeError:
        result = response(400, {"error": translate(lang, "Некорректный JSON")})
    except Exception as exc:
        if error_code(exc) == "UserNotFoundException":
            result = response(404, {"error": translate(lang, "Такого пользователя нет")})
        elif conditional_failed(exc):
            result = response(409, {"error": translate(lang, "Тиддлер уже изменили или он уже есть. Обновите страницу и повторите.")})
        else:
            logger.exception("unhandled")
            result = response(500, {"error": translate(lang, "Внутренняя ошибка")})
    if 200 <= result["statusCode"] < 300:
        attach_file_cookies(result, event)
    logger.info("%s %s -> %s", method, path, result["statusCode"])
    return result


def route(method, parts, event):
    params = event.get("queryStringParameters") or {}
    if parts == ["me"] and method == "GET":
        return response(200, {"email": actor(event), "admin": is_admin(event)})
    if parts[:1] == ["admin"]:
        return admin_route(method, parts[1:], params, event)
    if parts == ["tiddlers"] and method == "GET":
        return list_tiddlers(params)
    if parts == ["tiddlers", "get"] and method == "POST":
        return get_tiddlers(event)
    if parts == ["search"] and method == "GET":
        return search(params.get("q"))
    if parts == ["tasks"] and method == "GET":
        return open_tasks(params.get("tag"))
    if parts == ["tiddler"] and method == "GET":
        return get_tiddler(params.get("title"))
    if parts == ["tiddler"] and method == "PUT":
        return put_tiddler(event)
    if parts == ["tiddler"] and method == "DELETE":
        return delete_tiddler(params.get("title"), params.get("etag"), event)
    if parts == ["revisions"] and method == "GET":
        return list_revisions(params.get("title"))
    if parts == ["files"] and method == "POST":
        return presign_file(event)
    if parts == ["state"] and method == "GET":
        return get_state(event)
    if parts == ["state", "story"] and method == "PUT":
        return put_story(event)
    if parts == ["state", "draft"] and method == "PUT":
        return put_draft(event)
    if parts == ["state", "draft"] and method == "DELETE":
        return delete_draft(params.get("key"), event)
    raise ApiError(404, "Не найдено")


def list_tiddlers(params):
    from boto3.dynamodb.conditions import Key

    kwargs = {
        "IndexName": "tiddlers",
        "KeyConditionExpression": Key("gsi1pk").eq("TIDDLER"),
    }
    cursor = decode_cursor(params.get("cursor"))
    if cursor:
        kwargs["ExclusiveStartKey"] = cursor
    # One query page is at most 1 MB, well within the Lambda response limit.
    resp = table().query(**kwargs)
    items = with_meta(resp.get("Items", []))
    return response(200, {
        "items": [public_meta(item) for item in items],
        "next_cursor": encode_cursor(resp.get("LastEvaluatedKey")),
    })


def with_meta(items):
    """Fills in links and size for tiddlers saved before they were kept."""
    stale = [item for item in items if "links" not in item]
    for start in range(0, len(stale), 100):
        chunk = stale[start:start + 100]
        full = {item["title"]: item for item in batch_get([item["title"] for item in chunk])}
        for item in chunk:
            source = full.get(item["title"])
            if not source:
                continue
            meta = text_meta(source.get("text", ""), source.get("type"))
            item.update(meta)
            try:
                table().update_item(
                    Key={"pk": tiddler_pk(item["title"]), "sk": "CURRENT"},
                    # SIZE is a reserved word in DynamoDB expressions.
                    UpdateExpression="SET #l = :l, #s = :s",
                    ConditionExpression="etag = :e",
                    ExpressionAttributeNames={"#l": "links", "#s": "size"},
                    ExpressionAttributeValues={":l": meta["links"], ":s": meta["size"], ":e": source.get("etag", "")},
                )
            except Exception as exc:
                if not conditional_failed(exc):
                    raise
    return items


def batch_get(titles):
    found = []
    keys = [{"pk": tiddler_pk(title), "sk": "CURRENT"} for title in dict.fromkeys(titles)]
    for start in range(0, len(keys), 100):
        request = {table_name(): {"Keys": keys[start:start + 100]}}
        while request:
            answer = dynamo_resource().batch_get_item(RequestItems=request)
            found.extend(answer.get("Responses", {}).get(table_name(), []))
            request = answer.get("UnprocessedKeys") or None
    return found


def get_tiddlers(event):
    titles = body_json(event).get("titles")
    if not isinstance(titles, list) or len(titles) > 100:
        raise ApiError(400, "Нужен список до {count} названий", count=100)
    titles = [validate_title(title) for title in titles]
    return response(200, {"items": [public_tiddler(item) for item in batch_get(titles)]})


def scan_current(fields):
    """Every current tiddler with the given attributes, straight from the table."""
    from boto3.dynamodb.conditions import Attr

    names = {f"#f{n}": field for n, field in enumerate(fields)}
    kwargs = {
        "FilterExpression": Attr("sk").eq("CURRENT"),
        "ProjectionExpression": ", ".join(names),
        "ExpressionAttributeNames": names,
    }
    while True:
        resp = table().scan(**kwargs)
        yield from resp.get("Items", [])
        if not resp.get("LastEvaluatedKey"):
            return
        kwargs["ExclusiveStartKey"] = resp["LastEvaluatedKey"]


def fold(text):
    return str(text or "").lower().replace("ё", "е")


def search(query):
    words = fold(query).split()[:8]
    if not words:
        return response(200, {"items": []})
    in_title, in_text = [], []
    for item in scan_current(["title", "tags", "text"]):
        title = fold(item.get("title"))
        haystack = title + " " + fold(" ".join(item.get("tags") or [])) + " " + fold(item.get("text"))
        if all(word in haystack for word in words):
            (in_title if all(word in title for word in words) else in_text).append(item["title"])
    return response(200, {"items": (sorted(in_title) + sorted(in_text))[:SEARCH_MAX]})


def open_tasks(tag):
    groups = []
    for item in scan_current(["title", "tags", "type", "text"]):
        if tag and tag not in (item.get("tags") or []):
            continue
        tasks = [task for task in scan_tasks(item.get("text", ""), item.get("type")) if not task["done"]]
        if tasks:
            groups.append({"title": item["title"], "type": item.get("type") or DEFAULT_TYPE, "tasks": tasks})
    groups.sort(key=lambda group: group["title"].lower())
    return response(200, {"items": groups})


def get_tiddler(title):
    title = validate_title(title)
    item = get_current(title)
    if not item:
        raise ApiError(404, "Тиддлера нет")
    return response(200, public_tiddler(item))


def put_tiddler(event):
    body = body_json(event)
    title = validate_title(body.get("title"))
    text = clean_text(body.get("text"))
    tags = clean_tags(body.get("tags"))
    kind = body.get("type") or DEFAULT_TYPE
    if kind not in TYPES:
        raise ApiError(400, "Неизвестный тип тиддлера")
    etag = body.get("etag") or ""
    from_title = body.get("from_title") or ""
    now = now_iso()
    who = actor(event)

    if from_title and from_title != title:
        from_title = validate_title(from_title)
        old = get_current(from_title)
        if not old or old.get("etag") != etag:
            raise ApiError(409, "Тиддлер уже изменили. Обновите страницу и повторите.")
        if get_current(title):
            raise ApiError(409, "Тиддлер с таким названием уже есть")
        item = current_item(title, text, tags, kind, old.get("created") or now, old.get("creator") or who, now, who)
        transact([
            put_action(item, "attribute_not_exists(pk)"),
            delete_action(from_title, old["etag"]),
            put_action(revision_item(item, "rename", now, who, {"from_title": from_title}), None),
            put_action(revision_item(old, "rename", now, who, {"to_title": title}), None),
        ])
        return response(200, public_tiddler(item))

    old = get_current(title)
    if etag:
        if not old:
            raise ApiError(409, "Тиддлер уже удалили. Сохраните его как новый.")
        condition = etag
    else:
        if old:
            raise ApiError(409, "Тиддлер с таким названием уже есть")
        condition = None
    created = (old or {}).get("created") or now
    creator = (old or {}).get("creator") or who
    item = current_item(title, text, tags, kind, created, creator, now, who)
    transact([
        put_action(item, "etag = :etag" if condition else "attribute_not_exists(pk)", {":etag": condition} if condition else None),
        put_action(revision_item(item, "save" if old else "create", now, who), None),
    ])
    return response(200, public_tiddler(item))


def delete_tiddler(title, etag, event):
    title = validate_title(title)
    old = get_current(title)
    if not old:
        raise ApiError(404, "Тиддлера нет")
    if not etag or old.get("etag") != etag:
        raise ApiError(409, "Тиддлер уже изменили. Обновите страницу и повторите.")
    now = now_iso()
    transact([
        delete_action(title, etag),
        put_action(revision_item(old, "delete", now, actor(event)), None),
    ])
    return response(200, {"deleted": title})


def list_revisions(title):
    from boto3.dynamodb.conditions import Key

    title = validate_title(title)
    resp = table().query(
        KeyConditionExpression=Key("pk").eq(tiddler_pk(title)) & Key("sk").begins_with("REV#"),
        ScanIndexForward=False,
        Limit=REVISIONS_MAX,
    )
    items = []
    for item in resp.get("Items", []):
        entry = public_tiddler(item)
        entry["action"] = item.get("action") or "save"
        entry["at"] = item.get("at") or entry.get("modified")
        entry["by"] = item.get("by") or entry.get("modifier")
        for key in ("from_title", "to_title"):
            if item.get(key):
                entry[key] = item[key]
        items.append(entry)
    return response(200, {"items": items})


def presign_file(event):
    body = body_json(event)
    name = safe_file_name(body.get("name"))
    content_type = str(body.get("content_type") or "application/octet-stream").lower()
    if not CONTENT_TYPE_RE.fullmatch(content_type) or len(content_type) > 100:
        content_type = "application/octet-stream"
    size = as_int(body.get("size"))
    limit = file_max_bytes()
    if size < 1 or size > limit:
        raise ApiError(400, "Файл должен быть не больше {mb} МБ", mb=limit // (1024 * 1024))
    key = f"files/{uuid.uuid4().hex[:16]}/{name}"
    post = s3().generate_presigned_post(
        Bucket=env("FILES_BUCKET"),
        Key=key,
        Fields={"Content-Type": content_type},
        Conditions=[
            {"Content-Type": content_type},
            ["content-length-range", 1, limit],
        ],
        ExpiresIn=300,
    )
    return response(200, {"post": post, "path": "/" + key, "name": name, "content_type": content_type})


def get_state(event):
    from boto3.dynamodb.conditions import Key

    story = None
    drafts = []
    kwargs = {"KeyConditionExpression": Key("pk").eq(user_pk(event))}
    while True:
        resp = table().query(**kwargs)
        for item in resp.get("Items", []):
            if item["sk"] == "STORY":
                story = list(item.get("titles") or [])
            elif item["sk"].startswith("DRAFT#"):
                drafts.append(public_draft(item))
        if not resp.get("LastEvaluatedKey"):
            break
        kwargs["ExclusiveStartKey"] = resp["LastEvaluatedKey"]
    drafts.sort(key=lambda draft: draft["modified"])
    return response(200, {"story": story, "drafts": drafts})


def put_story(event):
    body = body_json(event)
    titles = body.get("titles")
    if not isinstance(titles, list) or len(titles) > STORY_MAX:
        raise ApiError(400, "Нужен список до {count} названий", count=STORY_MAX)
    clean = []
    for title in titles:
        title = clean_line(title, TITLE_MAX)
        if title and title not in clean:
            clean.append(title)
    now = now_iso()
    table().put_item(Item={"pk": user_pk(event), "sk": "STORY", "titles": clean, "modified": now})
    return response(200, {"modified": now})


def put_draft(event):
    body = body_json(event)
    key = clean_line(body.get("key"), TITLE_MAX)
    if not key:
        raise ApiError(400, "Нужен ключ черновика")
    kind = body.get("type") or DEFAULT_TYPE
    if kind not in TYPES:
        kind = DEFAULT_TYPE
    tags = body.get("tags") or []
    if not isinstance(tags, list) or len(tags) > TAGS_MAX:
        raise ApiError(400, "Не больше {count} тегов", count=TAGS_MAX)
    etag = str(body.get("etag") or "")
    if not ETAG_RE.fullmatch(etag):
        raise ApiError(400, "Некорректный etag")
    pk = user_pk(event)
    sk = "DRAFT#" + key
    if "Item" not in table().get_item(Key={"pk": pk, "sk": sk}):
        if count_drafts(pk) >= DRAFTS_MAX:
            raise ApiError(400, "Черновиков уже {count}. Сохраните или отмените часть правок.", count=DRAFTS_MAX)
    now = now_iso()
    table().put_item(Item={
        "pk": pk,
        "sk": sk,
        "key": key,
        # A draft title may be half typed, so only length and control characters are checked here.
        "title": clean_line(body.get("title"), TITLE_MAX),
        "text": clean_text(body.get("text")),
        "tags": [tag for tag in (clean_line(tag, TITLE_MAX) for tag in tags) if tag],
        "type": kind,
        "etag": etag,
        "original": clean_line(body.get("original"), TITLE_MAX),
        "fresh": bool(body.get("fresh")),
        "modified": now,
    })
    return response(200, {"modified": now})


def delete_draft(key, event):
    key = clean_line(key, TITLE_MAX)
    if not key:
        raise ApiError(400, "Нужен ключ черновика")
    table().delete_item(Key={"pk": user_pk(event), "sk": "DRAFT#" + key})
    return response(200, {"deleted": key})


def count_drafts(pk):
    from boto3.dynamodb.conditions import Key

    resp = table().query(
        KeyConditionExpression=Key("pk").eq(pk) & Key("sk").begins_with("DRAFT#"),
        Select="COUNT",
    )
    return resp.get("Count", 0)


def public_draft(item):
    return {
        "key": item.get("key", ""),
        "title": item.get("title", ""),
        "text": item.get("text", ""),
        "tags": list(item.get("tags") or []),
        "type": item.get("type") or DEFAULT_TYPE,
        "etag": item.get("etag", ""),
        "original": item.get("original", ""),
        "fresh": bool(item.get("fresh")),
        "modified": item.get("modified", ""),
    }


def user_pk(event):
    return "U#" + actor(event)


def admin_route(method, parts, params, event):
    if not is_admin(event):
        raise ApiError(403, "Нужны права администратора")
    if parts == ["users"] and method == "GET":
        return list_users(event)
    if parts == ["users"] and method == "POST":
        return create_user(event)
    if parts == ["users"] and method == "PUT":
        return update_user(event)
    if parts == ["users"] and method == "DELETE":
        return delete_user(params.get("email"), event)
    if parts == ["files"] and method == "GET":
        orphans = orphan_files()
        return response(200, {"items": orphans, "bytes": sum(item["size"] for item in orphans)})
    if parts == ["files", "cleanup"] and method == "POST":
        return cleanup_files(event)
    raise ApiError(404, "Не найдено")


def is_admin(event):
    claims = event.get("requestContext", {}).get("authorizer", {}).get("jwt", {}).get("claims", {})
    groups = claims.get("cognito:groups") or []
    if isinstance(groups, str):
        # API Gateway passes a list claim as a string such as "[admins other]".
        groups = groups.strip("[]").replace(",", " ").split()
    return os.environ.get("ADMIN_GROUP", "admins") in groups


def list_users(event):
    pool = env("USER_POOL_ID")
    admins = set()
    for page in cognito().get_paginator("list_users_in_group").paginate(UserPoolId=pool, GroupName=admin_group()):
        admins.update(user_email(user) for user in page.get("Users", []))
    users = []
    for page in cognito().get_paginator("list_users").paginate(UserPoolId=pool):
        for user in page.get("Users", []):
            email = user_email(user)
            users.append({
                "email": email,
                "status": user.get("UserStatus", ""),
                "enabled": bool(user.get("Enabled", True)),
                "created": iso(user.get("UserCreateDate")),
                "admin": email in admins,
                "self": email == actor(event),
            })
    users.sort(key=lambda user: user["email"])
    return response(200, {"items": users})


def create_user(event):
    body = body_json(event)
    email = validate_email(body.get("email"))
    password = temporary_password()
    emailed = os.environ.get("INVITE_EMAILS", "true") == "true"
    # A public demo does not send mail: anyone could otherwise make it email
    # strangers. The temporary password is shown to the administrator instead.
    delivery = {"DesiredDeliveryMediums": ["EMAIL"]} if emailed else {"MessageAction": "SUPPRESS"}
    try:
        cognito().admin_create_user(
            UserPoolId=env("USER_POOL_ID"),
            Username=email,
            UserAttributes=[
                {"Name": "email", "Value": email},
                {"Name": "email_verified", "Value": "true"},
            ],
            TemporaryPassword=password,
            **delivery,
        )
    except Exception as exc:
        if error_code(exc) == "UsernameExistsException":
            raise ApiError(409, "Такой пользователь уже есть") from exc
        raise
    if body.get("admin"):
        cognito().admin_add_user_to_group(UserPoolId=env("USER_POOL_ID"), Username=email, GroupName=admin_group())
    return response(200, {"email": email, "temporary_password": password, "emailed": emailed})


def update_user(event):
    body = body_json(event)
    email = validate_email(body.get("email"))
    pool = env("USER_POOL_ID")
    own = email == actor(event)
    result = {"email": email}
    if "enabled" in body:
        if own and not body["enabled"]:
            raise ApiError(400, "Нельзя отключить самого себя")
        if body["enabled"]:
            cognito().admin_enable_user(UserPoolId=pool, Username=email)
        else:
            cognito().admin_disable_user(UserPoolId=pool, Username=email)
    if "admin" in body:
        if own and not body["admin"]:
            raise ApiError(400, "Нельзя снять права администратора с самого себя")
        if body["admin"]:
            cognito().admin_add_user_to_group(UserPoolId=pool, Username=email, GroupName=admin_group())
        else:
            cognito().admin_remove_user_from_group(UserPoolId=pool, Username=email, GroupName=admin_group())
    if body.get("reset_password"):
        password = temporary_password()
        cognito().admin_set_user_password(UserPoolId=pool, Username=email, Password=password, Permanent=False)
        result["temporary_password"] = password
    return response(200, result)


def delete_user(email, event):
    email = validate_email(email)
    if email == actor(event):
        raise ApiError(400, "Нельзя удалить самого себя")
    cognito().admin_delete_user(UserPoolId=env("USER_POOL_ID"), Username=email)
    # The user's open tiddlers and drafts go too; the tiddlers they wrote stay.
    from boto3.dynamodb.conditions import Key

    resp = table().query(KeyConditionExpression=Key("pk").eq("U#" + email), ProjectionExpression="pk, sk")
    for item in resp.get("Items", []):
        table().delete_item(Key={"pk": item["pk"], "sk": item["sk"]})
    return response(200, {"deleted": email})


def referenced_text():
    from boto3.dynamodb.conditions import Attr

    texts = [item.get("text", "") for item in scan_current(["text"])]
    kwargs = {"FilterExpression": Attr("sk").begins_with("DRAFT#"), "ProjectionExpression": "#t", "ExpressionAttributeNames": {"#t": "text"}}
    while True:
        resp = table().scan(**kwargs)
        texts.extend(item.get("text", "") for item in resp.get("Items", []))
        if not resp.get("LastEvaluatedKey"):
            break
        kwargs["ExclusiveStartKey"] = resp["LastEvaluatedKey"]
    return "\n".join(texts)


def orphan_files():
    """Files that no current tiddler or draft mentions, older than an hour.

    The hour leaves room for an upload that has not reached a draft yet.
    """
    used = referenced_text()
    cutoff = time.time() - FILE_GRACE_SECONDS
    orphans = []
    for page in s3().get_paginator("list_objects_v2").paginate(Bucket=env("FILES_BUCKET"), Prefix="files/"):
        for obj in page.get("Contents", []):
            key = obj["Key"]
            if "/" + key in used or obj["LastModified"].timestamp() > cutoff:
                continue
            orphans.append({"key": key, "path": "/" + key, "size": obj.get("Size", 0), "modified": iso(obj["LastModified"])})
    orphans.sort(key=lambda item: item["modified"])
    return orphans


def cleanup_files(event):
    body = body_json(event)
    wanted = body.get("keys")
    if not isinstance(wanted, list):
        raise ApiError(400, "Нужен список файлов")
    # Check again: a file picked a minute ago may be in use now.
    orphans = {item["key"]: item for item in orphan_files()}
    keys = [key for key in dict.fromkeys(wanted) if isinstance(key, str) and key in orphans]
    deleted = []
    for start in range(0, len(keys), 1000):
        chunk = keys[start:start + 1000]
        resp = s3().delete_objects(Bucket=env("FILES_BUCKET"), Delete={"Objects": [{"Key": key} for key in chunk], "Quiet": True})
        failed = {error["Key"] for error in resp.get("Errors", [])}
        deleted.extend(key for key in chunk if key not in failed)
    logger.info("%s removed %d unused files", actor(event), len(deleted))
    return response(200, {
        "deleted": deleted,
        "skipped": [key for key in wanted if key not in deleted],
        "bytes": sum(orphans[key]["size"] for key in deleted),
    })


def validate_email(value):
    email = str(value or "").strip().lower()
    if not EMAIL_RE.fullmatch(email) or len(email) > 254:
        raise ApiError(400, "Нужен адрес почты")
    return email


def temporary_password():
    alphabet = string.ascii_letters + string.digits + PASSWORD_SYMBOLS
    while True:
        password = "".join(secrets.choice(alphabet) for _ in range(16))
        if (any(c.islower() for c in password) and any(c.isupper() for c in password)
                and any(c.isdigit() for c in password) and any(c in PASSWORD_SYMBOLS for c in password)):
            return password


def user_email(user):
    for attribute in user.get("Attributes", []):
        if attribute.get("Name") == "email":
            return attribute.get("Value", "").lower()
    return user.get("Username", "")


def admin_group():
    return os.environ.get("ADMIN_GROUP", "admins")


def iso(value):
    if not value:
        return ""
    return value.astimezone(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def error_code(exc):
    data = getattr(exc, "response", None)
    return data.get("Error", {}).get("Code", "") if isinstance(data, dict) else ""


def get_current(title):
    resp = table().get_item(Key={"pk": tiddler_pk(title), "sk": "CURRENT"}, ConsistentRead=True)
    return resp.get("Item")


def current_item(title, text, tags, kind, created, creator, modified, modifier):
    return {
        **text_meta(text, kind),
        "pk": tiddler_pk(title),
        "sk": "CURRENT",
        "gsi1pk": "TIDDLER",
        "gsi1sk": title,
        "title": title,
        "text": text,
        "tags": tags,
        "type": kind,
        "created": created,
        "creator": creator,
        "modified": modified,
        "modifier": modifier,
        "etag": uuid.uuid4().hex,
    }


def revision_item(item, action, now, who, extra=None):
    rev = {
        "pk": tiddler_pk(item["title"]),
        # Microseconds keep two saves made within one millisecond in order.
        "sk": f"REV#{datetime.now(timezone.utc).strftime('%Y-%m-%dT%H:%M:%S.%fZ')}#{uuid.uuid4().hex[:8]}",
        "action": action,
        "at": now,
        "by": who,
    }
    for key in ("title", "text", "tags", "type", "created", "creator", "modified", "modifier"):
        if key in item:
            rev[key] = item[key]
    rev.update(extra or {})
    return rev


def public_meta(item):
    return {
        "title": item.get("title", ""),
        "tags": list(item.get("tags") or []),
        "type": item.get("type") or DEFAULT_TYPE,
        "created": item.get("created", ""),
        "creator": item.get("creator", ""),
        "modified": item.get("modified", ""),
        "modifier": item.get("modifier", ""),
        "etag": item.get("etag", ""),
        "links": list(item.get("links") or []),
        "size": as_int(item.get("size")),
    }


def public_tiddler(item):
    return {
        **public_meta(item),
        "text": item.get("text", ""),
        "tags": list(item.get("tags") or []),
        "type": item.get("type") or DEFAULT_TYPE,
        "created": item.get("created", ""),
        "creator": item.get("creator", ""),
        "modified": item.get("modified", ""),
        "modifier": item.get("modifier", ""),
        "etag": item.get("etag", ""),
    }


def put_action(item, condition, values=None):
    action = {"TableName": table_name(), "Item": marshal_item(item)}
    if condition:
        action["ConditionExpression"] = condition
    if values:
        action["ExpressionAttributeValues"] = marshal_item(values)
    return {"Put": action}


def delete_action(title, etag):
    return {"Delete": {
        "TableName": table_name(),
        "Key": marshal_item({"pk": tiddler_pk(title), "sk": "CURRENT"}),
        "ConditionExpression": "etag = :etag",
        "ExpressionAttributeValues": marshal_item({":etag": etag}),
    }}


def transact(actions):
    ddb().transact_write_items(TransactItems=actions)


def validate_title(value):
    if not isinstance(value, str):
        raise ApiError(400, "Нужно название")
    value = value.strip()
    if not value:
        raise ApiError(400, "Нужно название")
    if len(value) > TITLE_MAX:
        raise ApiError(400, "Название длиннее {count} символов", count=TITLE_MAX)
    if BAD_TITLE_RE.search(value):
        raise ApiError(400, "В названии нельзя использовать [ ] { } | и переводы строки")
    return value


def clean_text(value):
    if value is None:
        return ""
    if not isinstance(value, str):
        raise ApiError(400, "Текст должен быть строкой")
    value = value.replace("\r\n", "\n")
    if len(value.encode("utf-8")) > TEXT_MAX_BYTES:
        raise ApiError(413, "Текст слишком длинный")
    return value


def clean_line(value, limit):
    if not isinstance(value, str):
        return ""
    return re.sub(r"[\x00-\x1f\x7f]", "", value).strip()[:limit]


def clean_tags(value):
    if value is None:
        return []
    if not isinstance(value, list):
        raise ApiError(400, "Теги должны быть списком")
    tags = []
    for tag in value:
        tag = validate_title(tag)
        if tag not in tags:
            tags.append(tag)
    if len(tags) > TAGS_MAX:
        raise ApiError(400, "Не больше {count} тегов", count=TAGS_MAX)
    return tags


def safe_file_name(value):
    name = str(value or "").strip().replace("\\", "/").split("/")[-1]
    stem, dot, ext = name.rpartition(".")
    if not dot:
        stem, ext = name, ""
    stem = re.sub(r"[^A-Za-z0-9_-]+", "-", stem).strip("-")[:80] or "file"
    ext = re.sub(r"[^A-Za-z0-9]+", "", ext)[:10].lower()
    return f"{stem}.{ext}" if ext else stem


def tiddler_pk(title):
    return "T#" + title


def body_json(event):
    raw = event.get("body") or ""
    if event.get("isBase64Encoded") and raw:
        raw = base64.b64decode(raw).decode("utf-8")
    if not raw:
        return {}
    if len(raw) > BODY_MAX:
        raise ApiError(413, "Слишком большой запрос")
    value = json.loads(raw)
    if not isinstance(value, dict):
        raise ApiError(400, "Ожидался объект JSON")
    return value


def response(status, payload):
    return {
        "statusCode": status,
        "headers": {
            "content-type": "application/json; charset=utf-8",
            "cache-control": "no-store",
        },
        "body": json.dumps(payload, ensure_ascii=False),
    }


def actor(event):
    claims = event.get("requestContext", {}).get("authorizer", {}).get("jwt", {}).get("claims", {})
    return claims.get("email") or claims.get("cognito:username") or claims.get("sub") or "unknown"


def encode_cursor(key):
    if not key:
        return None
    return base64.urlsafe_b64encode(json.dumps(key, ensure_ascii=False).encode("utf-8")).decode("ascii")


def decode_cursor(value):
    if not value:
        return None
    try:
        data = json.loads(base64.urlsafe_b64decode(value.encode("ascii")).decode("utf-8"))
    except (ValueError, UnicodeError) as exc:
        raise ApiError(400, "Некорректный курсор") from exc
    if not isinstance(data, dict) or set(data) != {"pk", "sk", "gsi1pk", "gsi1sk"}:
        raise ApiError(400, "Некорректный курсор")
    return data


def now_iso():
    return datetime.now(timezone.utc).isoformat(timespec="milliseconds").replace("+00:00", "Z")


def as_int(value, default=0):
    try:
        return int(value)
    except (TypeError, ValueError):
        return default


def conditional_failed(exc):
    response_data = getattr(exc, "response", None)
    if not isinstance(response_data, dict):
        return False
    code = response_data.get("Error", {}).get("Code", "")
    if code == "ConditionalCheckFailedException":
        return True
    if code != "TransactionCanceledException":
        return False
    reasons = response_data.get("CancellationReasons", [])
    return any(reason.get("Code") == "ConditionalCheckFailed" for reason in reasons)


def viewer_host(event):
    headers = {str(key).lower(): value for key, value in (event.get("headers") or {}).items()}
    host = headers.get("x-viewer-host") or ""
    host = host.split(",")[0].strip().split(":")[0]
    if not host or "execute-api" in host:
        return ""
    return host


def attach_file_cookies(result, event):
    host = viewer_host(event)
    if not host:
        return
    try:
        result["cookies"] = file_cookies(host)
    except Exception:
        logger.exception("file cookie was not issued")


def file_cookies(host, now=None):
    expires = int(now if now is not None else time.time()) + COOKIE_SECONDS
    policy = json.dumps({
        "Statement": [{
            "Resource": f"https://{host}/files/*",
            "Condition": {"DateLessThan": {"AWS:EpochTime": expires}},
        }]
    }, separators=(",", ":")).encode("utf-8")
    signature = rsa_sha1_sign(policy, signing_key())
    attributes = f"Path=/files; Secure; HttpOnly; SameSite=Lax; Max-Age={COOKIE_SECONDS}"
    return [
        f"CloudFront-Policy={cloudfront_b64(policy)}; {attributes}",
        f"CloudFront-Signature={cloudfront_b64(signature)}; {attributes}",
        f"CloudFront-Key-Pair-Id={env('CLOUDFRONT_KEY_PAIR_ID')}; {attributes}",
    ]


def cloudfront_b64(data):
    return base64.b64encode(data).decode("ascii").replace("+", "-").replace("=", "_").replace("/", "~")


def signing_key():
    global _signing_key
    if _signing_key is None:
        import boto3

        parameter = boto3.client("ssm").get_parameter(Name=env("FILES_KEY_PARAMETER_NAME"), WithDecryption=True)
        _signing_key = load_rsa_private_key(parameter["Parameter"]["Value"])
    return _signing_key


# CloudFront wants RSASSA-PKCS1-v1_5 with SHA-1. The runtime has no crypto
# package, so the key is read from its DER form and signed with plain pow().
def der_read(data, offset):
    tag = data[offset]
    length = data[offset + 1]
    offset += 2
    if length & 0x80:
        count = length & 0x7F
        length = int.from_bytes(data[offset:offset + count], "big")
        offset += count
    return tag, data[offset:offset + length], offset + length


def der_sequence(data):
    items = []
    offset = 0
    while offset < len(data):
        tag, value, offset = der_read(data, offset)
        items.append((tag, value))
    return items


def load_rsa_private_key(pem):
    lines = [line.strip() for line in pem.strip().splitlines()]
    der = base64.b64decode("".join(line for line in lines if line and not line.startswith("-----")))
    _, body, _ = der_read(der, 0)
    items = der_sequence(body)
    if len(items) == 3 and items[2][0] == 0x04:
        # PKCS#8 wraps the PKCS#1 key in an OCTET STRING.
        _, body, _ = der_read(items[2][1], 0)
        items = der_sequence(body)
    numbers = [int.from_bytes(value, "big") for tag, value in items if tag == 0x02]
    _, n, e, d, p, q, dp, dq, qinv = numbers[:9]
    return {"n": n, "e": e, "d": d, "p": p, "q": q, "dp": dp, "dq": dq, "qinv": qinv}


def rsa_sha1_sign(message, key):
    size = (key["n"].bit_length() + 7) // 8
    digest = SHA1_DIGEST_INFO + hashlib.sha1(message).digest()
    encoded = b"\x00\x01" + b"\xff" * (size - len(digest) - 3) + b"\x00" + digest
    m = int.from_bytes(encoded, "big")
    s1 = pow(m, key["dp"], key["p"])
    s2 = pow(m, key["dq"], key["q"])
    h = (key["qinv"] * (s1 - s2)) % key["p"]
    return (s2 + h * key["q"]).to_bytes(size, "big")


def table_name():
    return env("TABLE_NAME")


def file_max_bytes():
    return as_int(os.environ.get("FILE_MAX_BYTES"), 26214400)


def env(name):
    value = os.environ.get(name)
    if not value:
        raise ApiError(500, "Сервис не настроен")
    return value


def table():
    global _table
    if _table is None:
        import boto3

        _table = boto3.resource("dynamodb").Table(table_name())
    return _table


def cognito():
    global _cognito
    if _cognito is None:
        import boto3

        _cognito = boto3.client("cognito-idp")
    return _cognito


def dynamo_resource():
    global _resource
    if _resource is None:
        import boto3

        _resource = boto3.resource("dynamodb")
    return _resource


def ddb():
    global _ddb
    if _ddb is None:
        import boto3

        _ddb = boto3.client("dynamodb")
    return _ddb


def s3():
    global _s3
    if _s3 is None:
        import boto3
        from botocore.config import Config

        # Sign against the regional endpoint. The global s3.amazonaws.com host
        # answers with a redirect, and a signed POST cannot follow it.
        region = os.environ.get("AWS_REGION") or os.environ.get("AWS_DEFAULT_REGION") or "eu-central-1"
        _s3 = boto3.client(
            "s3",
            region_name=region,
            endpoint_url=f"https://s3.{region}.amazonaws.com",
            config=Config(signature_version="s3v4", s3={"addressing_style": "virtual"}),
        )
    return _s3


def marshal(value):
    global _serializer
    if _serializer is None:
        from boto3.dynamodb.types import TypeSerializer

        _serializer = TypeSerializer()
    return _serializer.serialize(value)


def marshal_item(item):
    return {key: marshal(value) for key, value in item.items()}


# Error messages -----------------------------------------------------------
# The Russian text is the key, as on the page. The page sends its language in
# X-Wiki-Lang; other callers fall back to Accept-Language, then Russian.

LANGUAGES = ("ru", "en", "fr", "it")

MESSAGES = {
    "Не найдено": ("Not found", "Introuvable", "Non trovato"),
    "Некорректный JSON": ("Invalid JSON", "JSON invalide", "JSON non valido"),
    "Такого пользователя нет": ("No such user", "Utilisateur introuvable", "Utente inesistente"),
    "Тиддлер уже изменили или он уже есть. Обновите страницу и повторите.": (
        "The tiddler has changed or already exists. Reload the page and try again.",
        "Le tiddler a changé ou existe déjà. Rechargez la page et réessayez.",
        "Il tiddler è cambiato o esiste già. Ricarica la pagina e riprova.",
    ),
    "Внутренняя ошибка": ("Internal error", "Erreur interne", "Errore interno"),
    "Тиддлера нет": ("No such tiddler", "Tiddler introuvable", "Tiddler inesistente"),
    "Неизвестный тип тиддлера": ("Unknown tiddler type", "Type de tiddler inconnu", "Tipo di tiddler sconosciuto"),
    "Тиддлер уже изменили. Обновите страницу и повторите.": (
        "The tiddler has changed. Reload the page and try again.",
        "Le tiddler a changé. Rechargez la page et réessayez.",
        "Il tiddler è cambiato. Ricarica la pagina e riprova.",
    ),
    "Тиддлер с таким названием уже есть": (
        "A tiddler with this title already exists",
        "Un tiddler portant ce titre existe déjà",
        "Esiste già un tiddler con questo titolo",
    ),
    "Тиддлер уже удалили. Сохраните его как новый.": (
        "The tiddler has been deleted. Save it as a new one.",
        "Le tiddler a été supprimé. Enregistrez-le comme nouveau.",
        "Il tiddler è stato eliminato. Salvalo come nuovo.",
    ),
    "Файл должен быть не больше {mb} МБ": (
        "The file must be at most {mb} MB",
        "Le fichier ne doit pas dépasser {mb} Mo",
        "Il file non deve superare {mb} MB",
    ),
    "Нужен список до {count} названий": (
        "A list of up to {count} titles is needed",
        "Une liste de {count} titres au plus est attendue",
        "Serve un elenco di al massimo {count} titoli",
    ),
    "Нужен ключ черновика": ("A draft key is needed", "Une clé de brouillon est nécessaire", "Serve la chiave della bozza"),
    "Не больше {count} тегов": ("At most {count} tags", "{count} tags au maximum", "Al massimo {count} tag"),
    "Некорректный etag": ("Invalid etag", "etag invalide", "etag non valido"),
    "Черновиков уже {count}. Сохраните или отмените часть правок.": (
        "There are already {count} drafts. Save or cancel some edits.",
        "Il y a déjà {count} brouillons. Enregistrez ou annulez certaines modifications.",
        "Ci sono già {count} bozze. Salva o annulla alcune modifiche.",
    ),
    "Нужны права администратора": ("Administrator rights are needed", "Droits d’administrateur requis", "Servono i diritti di amministratore"),
    "Такой пользователь уже есть": ("This user already exists", "Cet utilisateur existe déjà", "Questo utente esiste già"),
    "Нельзя отключить самого себя": ("You cannot disable yourself", "Vous ne pouvez pas vous désactiver", "Non puoi disattivare te stesso"),
    "Нельзя снять права администратора с самого себя": (
        "You cannot remove your own administrator rights",
        "Vous ne pouvez pas retirer vos propres droits d’administrateur",
        "Non puoi toglierti i diritti di amministratore",
    ),
    "Нельзя удалить самого себя": ("You cannot delete yourself", "Vous ne pouvez pas vous supprimer", "Non puoi eliminare te stesso"),
    "Нужен список файлов": ("A list of files is needed", "Une liste de fichiers est attendue", "Serve un elenco di file"),
    "Нужен адрес почты": ("An email address is needed", "Une adresse e-mail est nécessaire", "Serve un indirizzo email"),
    "Нужно название": ("A title is needed", "Un titre est nécessaire", "Serve un titolo"),
    "Название длиннее {count} символов": (
        "The title is longer than {count} characters",
        "Le titre dépasse {count} caractères",
        "Il titolo supera {count} caratteri",
    ),
    "В названии нельзя использовать [ ] { } | и переводы строки": (
        "A title cannot contain [ ] { } | or line breaks",
        "Un titre ne peut pas contenir [ ] { } | ni de retour à la ligne",
        "Un titolo non può contenere [ ] { } | né a capo",
    ),
    "Текст должен быть строкой": ("The text must be a string", "Le texte doit être une chaîne", "Il testo deve essere una stringa"),
    "Текст слишком длинный": ("The text is too long", "Le texte est trop long", "Il testo è troppo lungo"),
    "Теги должны быть списком": ("Tags must be a list", "Les tags doivent être une liste", "I tag devono essere un elenco"),
    "Слишком большой запрос": ("The request is too large", "La requête est trop volumineuse", "La richiesta è troppo grande"),
    "Ожидался объект JSON": ("A JSON object was expected", "Un objet JSON était attendu", "Era atteso un oggetto JSON"),
    "Некорректный курсор": ("Invalid cursor", "Curseur invalide", "Cursore non valido"),
    "Сервис не настроен": ("The service is not configured", "Le service n’est pas configuré", "Il servizio non è configurato"),
}


def request_language(event):
    headers = {str(key).lower(): str(value) for key, value in (event.get("headers") or {}).items()}
    wanted = [headers.get("x-wiki-lang", "")]
    wanted += [part.split(";")[0] for part in headers.get("accept-language", "").split(",")]
    for tag in wanted:
        code = tag.strip().lower().split("-")[0]
        if code in LANGUAGES:
            return code
    return "ru"


def translate(lang, message, values=None):
    if lang != "ru" and message in MESSAGES:
        message = MESSAGES[message][LANGUAGES.index(lang) - 1]
    return re.sub(r"\{(\w+)\}", lambda m: str((values or {}).get(m.group(1), m.group(0))), message)


# Text rules shared with the page ---------------------------------------------
# These follow links() and scanTasks() in web/wikitext.js, so the server
# counts the same links and numbers the same tasks as the browser.

def text_meta(text, kind):
    return {"links": sorted(extract_links(text, kind)), "size": len((text or "").encode("utf-8"))}


def extract_links(text, kind):
    found = set()
    if kind == "text/plain":
        return found
    stripped = re.sub(r"```[\s\S]*?```", "", text or "")
    stripped = re.sub(r"``[\s\S]*?``", "", stripped)
    stripped = re.sub(r"`[^`\n]*`", "", stripped)
    for inner in re.findall(r"\[\[([^\]\n]+?)\]\]", stripped):
        target = inner.split("|", 1)[1] if "|" in inner else inner
        target = target.strip()
        if target and not EXTERNAL_RE.match(target):
            found.add(target)
    for inner in re.findall(r"\{\{([^{}\n]+)\}\}", stripped):
        target = inner.split("||")[0].split("!!")[0].strip()
        if target:
            found.add(target)
    if kind == "text/markdown":
        from urllib.parse import unquote

        for target in re.findall(r"(?:^|[^!])\[[^\]\n]+\]\(([^)\s]+)\)", stripped):
            target = unquote(target)
            if not EXTERNAL_RE.match(target) and not re.match(r"^[a-z]+:", target, re.I):
                found.add(target)
    return found


def scan_tasks(text, kind):
    if kind == "text/plain":
        return []
    pattern = TASK_MARKDOWN_RE if kind == "text/markdown" else TASK_WIKI_RE
    tasks, fenced = [], False
    for line in (text or "").replace("\r\n", "\n").split("\n"):
        if re.match(r"^\s*```", line):
            fenced = not fenced
            continue
        if fenced:
            continue
        m = pattern.match(line)
        if m:
            tasks.append({"index": len(tasks), "done": m.group(2) != " ", "text": line[m.end():].strip()})
    return tasks
