import base64
import json
import os
import subprocess
import tempfile
import unittest
from datetime import datetime, timedelta, timezone

import lambda_app


def key_match(condition, item):
    expr = condition.get_expression()
    op, values = expr["operator"], expr["values"]
    if op == "AND":
        return all(key_match(value, item) for value in values)
    name, value = values[0].name, values[1]
    if op == "=":
        return item.get(name) == value
    if op == "begins_with":
        return str(item.get(name, "")).startswith(value)
    raise AssertionError(op)


class FakeTable:
    def __init__(self):
        self.items = {}

    def get_item(self, Key, ConsistentRead=False):
        item = self.items.get((Key["pk"], Key["sk"]))
        return {"Item": dict(item)} if item else {}

    def put_item(self, Item):
        self.items[(Item["pk"], Item["sk"])] = dict(Item)

    def delete_item(self, Key):
        self.items.pop((Key["pk"], Key["sk"]), None)

    def update_item(self, Key, UpdateExpression, ConditionExpression, ExpressionAttributeNames, ExpressionAttributeValues):
        item = self.items[(Key["pk"], Key["sk"])]
        if item.get("etag") != ExpressionAttributeValues[":e"]:
            raise ConditionFailed()
        item[ExpressionAttributeNames["#l"]] = ExpressionAttributeValues[":l"]
        item[ExpressionAttributeNames["#s"]] = ExpressionAttributeValues[":s"]
        self.updates = getattr(self, "updates", 0) + 1

    def scan(self, **kwargs):
        condition = kwargs.get("FilterExpression")
        return {"Items": [item for item in self.items.values() if condition is None or key_match(condition, item)]}

    def query(self, **kwargs):
        items = [item for item in self.items.values() if key_match(kwargs["KeyConditionExpression"], item)]
        sort = "gsi1sk" if kwargs.get("IndexName") else "sk"
        items.sort(key=lambda item: item[sort], reverse=not kwargs.get("ScanIndexForward", True))
        if kwargs.get("Select") == "COUNT":
            return {"Count": len(items)}
        if kwargs.get("IndexName"):
            # The index holds everything but the text.
            items = [{k: v for k, v in item.items() if k != "text"} for item in items]
        return {"Items": items[:kwargs.get("Limit", len(items))]}


class Pager:
    def __init__(self, fn):
        self.fn = fn

    def paginate(self, **kwargs):
        return [self.fn(**kwargs)]


class FakeCognito:
    def __init__(self):
        self.users = {}
        self.groups = {"admins": set()}

    def get_paginator(self, name):
        return Pager(getattr(self, name))

    def list_users(self, UserPoolId):
        return {"Users": [dict(user, Attributes=[{"Name": "email", "Value": email}]) for email, user in self.users.items()]}

    def list_users_in_group(self, UserPoolId, GroupName):
        return {"Users": [{"Username": email, "Attributes": [{"Name": "email", "Value": email}]} for email in self.groups[GroupName]]}

    def admin_create_user(self, UserPoolId, Username, **kwargs):
        if Username in self.users:
            raise ClientError("UsernameExistsException")
        self.users[Username] = {"Username": Username, "UserStatus": "FORCE_CHANGE_PASSWORD", "Enabled": True,
                                "UserCreateDate": datetime.now(timezone.utc), "password": kwargs["TemporaryPassword"],
                                "delivery": kwargs.get("MessageAction") or ",".join(kwargs.get("DesiredDeliveryMediums", []))}

    def admin_delete_user(self, UserPoolId, Username):
        self.users.pop(Username)

    def admin_disable_user(self, UserPoolId, Username):
        if Username not in self.users:
            raise ClientError("UserNotFoundException")
        self.users[Username]["Enabled"] = False

    def admin_enable_user(self, UserPoolId, Username):
        self.users[Username]["Enabled"] = True

    def admin_add_user_to_group(self, UserPoolId, Username, GroupName):
        self.groups[GroupName].add(Username)

    def admin_remove_user_from_group(self, UserPoolId, Username, GroupName):
        self.groups[GroupName].discard(Username)

    def admin_set_user_password(self, UserPoolId, Username, Password, Permanent):
        self.users[Username].update(password=Password, UserStatus="FORCE_CHANGE_PASSWORD")


class FakeS3:
    def __init__(self):
        self.objects = {}

    def get_paginator(self, name):
        return Pager(lambda Bucket, Prefix: {"Contents": [
            {"Key": key, "Size": size, "LastModified": modified} for key, (size, modified) in sorted(self.objects.items()) if key.startswith(Prefix)
        ]})

    def delete_objects(self, Bucket, Delete):
        for obj in Delete["Objects"]:
            self.objects.pop(obj["Key"], None)
        return {}


class ClientError(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.response = {"Error": {"Code": code}}


class FakeResource:
    def __init__(self, table):
        self.table = table

    def batch_get_item(self, RequestItems):
        (name, request), = RequestItems.items()
        assert len(request["Keys"]) <= 100
        found = [dict(self.table.items[(k["pk"], k["sk"])]) for k in request["Keys"] if (k["pk"], k["sk"]) in self.table.items]
        return {"Responses": {name: found}}


class ConditionFailed(Exception):
    response = {"Error": {"Code": "TransactionCanceledException"}, "CancellationReasons": [{"Code": "ConditionalCheckFailed"}]}


class FakeDynamo:
    def __init__(self, table):
        from boto3.dynamodb.types import TypeDeserializer

        self.table = table
        self.des = TypeDeserializer()

    def plain(self, data):
        return {key: self.des.deserialize(value) for key, value in data.items()}

    def check(self, key, condition, values):
        current = self.table.items.get(key)
        if condition == "attribute_not_exists(pk)" and current:
            raise ConditionFailed()
        if condition == "etag = :etag" and (not current or current.get("etag") != values[":etag"]):
            raise ConditionFailed()

    def transact_write_items(self, TransactItems):
        writes = []
        for action in TransactItems:
            kind, body = next(iter(action.items()))
            data = self.plain(body["Item"] if kind == "Put" else body["Key"])
            key = (data["pk"], data["sk"])
            self.check(key, body.get("ConditionExpression"), self.plain(body.get("ExpressionAttributeValues") or {}))
            writes.append((kind, key, data))
        for kind, key, data in writes:
            if kind == "Put":
                self.table.items[key] = data
            else:
                self.table.items.pop(key, None)


def event(method, path, body=None, params=None, email="person@example.com", groups=None):
    claims = {"email": email, "email_verified": "true"}
    if groups is not None:
        claims["cognito:groups"] = groups
    return {
        "rawPath": path,
        "requestContext": {
            "http": {"method": method},
            "authorizer": {"jwt": {"claims": claims}},
        },
        "queryStringParameters": params,
        "body": json.dumps(body) if body is not None else None,
    }


def call(method, path, body=None, params=None, email="person@example.com", groups=None):
    result = lambda_app.handler(event(method, path, body, params, email, groups), None)
    return result["statusCode"], json.loads(result["body"])


class WikiApiTest(unittest.TestCase):
    def setUp(self):
        os.environ["TABLE_NAME"] = "wiki"
        self.table = FakeTable()
        lambda_app._table = self.table
        lambda_app._ddb = FakeDynamo(self.table)
        lambda_app._resource = FakeResource(self.table)

    def test_list_has_no_text_and_texts_load_in_batches(self):
        call("PUT", "/api/tiddler", {"title": "Главная", "text": "См. [[Дом]], {{Вставка||tpl}} и [[сайт|https://x.org]]. `[[не ссылка]]`"})
        call("PUT", "/api/tiddler", {"title": "Дом", "text": "* [ ] купить хлеб\n* [x] позвонить\n```\n* [ ] в коде\n```", "tags": ["быт"]})
        call("PUT", "/api/tiddler", {"title": "Заметка", "text": "- [ ] md task\n[текст](Главная)", "type": "text/markdown"})
        items = {t["title"]: t for t in call("GET", "/api/tiddlers")[1]["items"]}
        self.assertNotIn("text", items["Главная"])
        self.assertEqual(items["Главная"]["links"], ["Вставка", "Дом"])
        self.assertEqual(items["Заметка"]["links"], ["Главная"])
        self.assertGreater(items["Дом"]["size"], 20)
        status, got = call("POST", "/api/tiddlers/get", {"titles": ["Дом", "Нет такого", "Главная"]})
        self.assertEqual(status, 200)
        self.assertEqual(sorted(t["title"] for t in got["items"]), ["Главная", "Дом"])
        self.assertIn("купить хлеб", next(t for t in got["items"] if t["title"] == "Дом")["text"])
        self.assertEqual(call("POST", "/api/tiddlers/get", {"titles": ["a"] * 101})[0], 400)

    def test_old_tiddlers_get_links_on_first_listing(self):
        call("PUT", "/api/tiddler", {"title": "Старый", "text": "[[Новый]]"})
        item = self.table.items[("T#Старый", "CURRENT")]
        del item["links"], item["size"]
        listed = call("GET", "/api/tiddlers")[1]["items"][0]
        self.assertEqual((listed["links"], listed["size"]), (["Новый"], len("[[Новый]]".encode())))
        self.assertEqual(self.table.items[("T#Старый", "CURRENT")]["links"], ["Новый"])
        call("GET", "/api/tiddlers")
        self.assertEqual(self.table.updates, 1)

    def test_search_and_tasks_run_on_the_server(self):
        call("PUT", "/api/tiddler", {"title": "Ёлка", "text": "игрушки и гирлянда", "tags": ["дом"]})
        call("PUT", "/api/tiddler", {"title": "Список", "text": "* [ ] ёлка\n* [x] шарики\n\n* [ ] свечи", "tags": ["дом"]})
        call("PUT", "/api/tiddler", {"title": "Работа", "text": "- [ ] отчёт", "type": "text/markdown", "tags": ["работа"]})
        self.assertEqual(call("GET", "/api/search", params={"q": "елка"})[1]["items"], ["Ёлка", "Список"])
        self.assertEqual(call("GET", "/api/search", params={"q": "гирлянда игрушки"})[1]["items"], ["Ёлка"])
        self.assertEqual(call("GET", "/api/search", params={"q": " "})[1]["items"], [])
        groups = call("GET", "/api/tasks")[1]["items"]
        self.assertEqual([g["title"] for g in groups], ["Работа", "Список"])
        self.assertEqual(groups[1]["tasks"], [{"index": 0, "done": False, "text": "ёлка"}, {"index": 2, "done": False, "text": "свечи"}])
        self.assertEqual([g["title"] for g in call("GET", "/api/tasks", params={"tag": "работа"})[1]["items"]], ["Работа"])

    def test_create_edit_rename_delete_keep_history(self):
        status, first = call("PUT", "/api/tiddler", {"title": "Главная", "text": "Привет", "tags": ["Дом", "Дом"]})
        self.assertEqual(status, 200)
        self.assertEqual(first["tags"], ["Дом"])
        self.assertEqual(first["creator"], "person@example.com")

        status, _ = call("PUT", "/api/tiddler", {"title": "Главная", "text": "Снова"})
        self.assertEqual(status, 409)

        status, second = call("PUT", "/api/tiddler", {"title": "Главная", "text": "Привет, мир", "etag": first["etag"]})
        self.assertEqual(status, 200)
        self.assertNotEqual(second["etag"], first["etag"])

        status, _ = call("PUT", "/api/tiddler", {"title": "Главная", "text": "Старое", "etag": first["etag"]})
        self.assertEqual(status, 409)

        status, renamed = call("PUT", "/api/tiddler", {
            "title": "Дом/Главная", "text": "Привет, мир", "etag": second["etag"], "from_title": "Главная",
        })
        self.assertEqual(status, 200)
        self.assertEqual(renamed["created"], first["created"])

        status, listing = call("GET", "/api/tiddlers")
        self.assertEqual([item["title"] for item in listing["items"]], ["Дом/Главная"])

        status, revisions = call("GET", "/api/revisions", params={"title": "Главная"})
        self.assertEqual([item["action"] for item in revisions["items"]][-2:], ["save", "create"])
        self.assertIn("rename", [item["action"] for item in revisions["items"]])

        status, _ = call("DELETE", "/api/tiddler", params={"title": "Дом/Главная", "etag": "wrong"})
        self.assertEqual(status, 409)
        status, _ = call("DELETE", "/api/tiddler", params={"title": "Дом/Главная", "etag": renamed["etag"]})
        self.assertEqual(status, 200)
        status, listing = call("GET", "/api/tiddlers")
        self.assertEqual(listing["items"], [])

    def test_story_and_drafts_are_kept_per_user(self):
        self.assertEqual(call("GET", "/api/state")[1], {"story": None, "drafts": []})
        status, _ = call("PUT", "/api/state/story", {"titles": ["Главная", "Главная", "Дом\n", ""]})
        self.assertEqual(status, 200)
        status, _ = call("PUT", "/api/state/draft", {
            "key": "Главная", "title": "Главная [черновик", "text": "новый текст", "tags": ["Дом"],
            "type": "text/markdown", "etag": "ab12", "original": "Главная",
        })
        self.assertEqual(status, 200)
        state = call("GET", "/api/state")[1]
        self.assertEqual(state["story"], ["Главная", "Дом"])
        self.assertEqual(len(state["drafts"]), 1)
        draft = state["drafts"][0]
        self.assertEqual((draft["key"], draft["title"], draft["text"], draft["type"]), ("Главная", "Главная [черновик", "новый текст", "text/markdown"))
        self.assertEqual(call("GET", "/api/state", email="other@example.com")[1], {"story": None, "drafts": []})
        self.assertEqual(call("GET", "/api/tiddlers")[1]["items"], [])
        self.assertEqual(call("DELETE", "/api/state/draft", params={"key": "Главная"})[0], 200)
        self.assertEqual(call("GET", "/api/state")[1]["drafts"], [])

    def test_draft_limits(self):
        self.assertEqual(call("PUT", "/api/state/draft", {"key": " ", "text": "x"})[0], 400)
        self.assertEqual(call("PUT", "/api/state/draft", {"key": "a", "etag": "<script>"})[0], 400)
        self.assertEqual(call("PUT", "/api/state/story", {"titles": "Главная"})[0], 400)
        for n in range(lambda_app.DRAFTS_MAX):
            self.assertEqual(call("PUT", "/api/state/draft", {"key": f"t{n}", "text": "x"})[0], 200)
        self.assertEqual(call("PUT", "/api/state/draft", {"key": "t0", "text": "y"})[0], 200)
        self.assertEqual(call("PUT", "/api/state/draft", {"key": "лишний", "text": "x"})[0], 400)

    def test_errors_follow_the_page_language(self):
        ev = event("PUT", "/api/tiddler", {"title": "a|b", "text": ""})
        ev["headers"] = {"X-Wiki-Lang": "fr"}
        self.assertIn("Un titre ne peut pas contenir", json.loads(lambda_app.handler(ev, None)["body"])["error"])
        ev["headers"] = {"Accept-Language": "it-IT,it;q=0.9,en;q=0.8"}
        self.assertIn("Un titolo non può contenere", json.loads(lambda_app.handler(ev, None)["body"])["error"])
        ev["headers"] = {}
        self.assertIn("В названии нельзя", json.loads(lambda_app.handler(ev, None)["body"])["error"])
        ev = event("PUT", "/api/tiddler", {"title": "x" * 300, "text": ""})
        ev["headers"] = {"X-Wiki-Lang": "en"}
        self.assertEqual(json.loads(lambda_app.handler(ev, None)["body"])["error"], "The title is longer than 250 characters")

    def test_titles_reject_link_syntax(self):
        for title in ["", "  ", "a|b", "[[x]]", "{{x}}", "a\nb", "x" * 251]:
            status, _ = call("PUT", "/api/tiddler", {"title": title, "text": ""})
            self.assertEqual(status, 400, title)

    def test_unknown_route_is_404(self):
        self.assertEqual(call("GET", "/api/nothing")[0], 404)


class AdminTest(unittest.TestCase):
    def setUp(self):
        os.environ.update(TABLE_NAME="wiki", USER_POOL_ID="pool", ADMIN_GROUP="admins", FILES_BUCKET="files")
        self.table = FakeTable()
        lambda_app._table = self.table
        lambda_app._ddb = FakeDynamo(self.table)
        lambda_app._resource = FakeResource(self.table)
        self.cognito = lambda_app._cognito = FakeCognito()
        self.s3 = lambda_app._s3 = FakeS3()
        self.cognito.users["boss@example.com"] = {"Username": "boss@example.com", "UserStatus": "CONFIRMED", "Enabled": True, "UserCreateDate": datetime.now(timezone.utc)}
        self.cognito.groups["admins"].add("boss@example.com")

    def admin(self, method, path, body=None, params=None):
        return call(method, path, body, params, email="boss@example.com", groups="[admins]")

    def test_only_admins_reach_admin_routes(self):
        self.assertEqual(call("GET", "/api/admin/users")[0], 403)
        self.assertEqual(call("GET", "/api/admin/users", groups="[readers]")[0], 403)
        self.assertEqual(self.admin("GET", "/api/admin/users")[0], 200)
        self.assertTrue(call("GET", "/api/me", email="boss@example.com", groups=["admins"])[1]["admin"])
        self.assertFalse(call("GET", "/api/me")[1]["admin"])

    def test_invite_update_and_delete_user(self):
        os.environ["INVITE_EMAILS"] = "false"
        status, created = self.admin("POST", "/api/admin/users", {"email": " New@Example.com ", "admin": True})
        self.assertEqual(status, 200)
        self.assertFalse(created["emailed"])
        self.assertEqual(self.cognito.users["new@example.com"]["delivery"], "SUPPRESS")
        self.assertEqual(created["email"], "new@example.com")
        password = created["temporary_password"]
        self.assertTrue(len(password) >= 12 and any(c.isupper() for c in password) and any(c in "!@#%&*-_=+" for c in password))
        self.assertEqual(self.admin("POST", "/api/admin/users", {"email": "new@example.com"})[0], 409)
        self.assertEqual(self.admin("POST", "/api/admin/users", {"email": "not-an-email"})[0], 400)
        users = {u["email"]: u for u in self.admin("GET", "/api/admin/users")[1]["items"]}
        self.assertTrue(users["new@example.com"]["admin"])
        self.assertTrue(users["boss@example.com"]["self"])

        self.admin("PUT", "/api/admin/users", {"email": "new@example.com", "enabled": False, "admin": False})
        users = {u["email"]: u for u in self.admin("GET", "/api/admin/users")[1]["items"]}
        self.assertFalse(users["new@example.com"]["enabled"])
        self.assertFalse(users["new@example.com"]["admin"])
        status, reset = self.admin("PUT", "/api/admin/users", {"email": "new@example.com", "reset_password": True})
        self.assertEqual(self.cognito.users["new@example.com"]["password"], reset["temporary_password"])

        call("PUT", "/api/state/story", {"titles": ["Главная"]}, email="new@example.com")
        self.assertEqual(self.admin("DELETE", "/api/admin/users", params={"email": "new@example.com"})[0], 200)
        self.assertNotIn("new@example.com", self.cognito.users)
        self.assertFalse([key for key in self.table.items if key[0] == "U#new@example.com"])

    def test_unknown_user_is_404(self):
        self.assertEqual(self.admin("PUT", "/api/admin/users", {"email": "nobody@example.com", "enabled": False})[0], 404)

    def test_unverified_email_is_refused(self):
        unverified = event("GET", "/api/state", email="boss@example.com")
        unverified["requestContext"]["authorizer"]["jwt"]["claims"]["email_verified"] = "false"
        self.assertEqual(lambda_app.handler(unverified, None)["statusCode"], 403)
        no_email = event("GET", "/api/me")
        del no_email["requestContext"]["authorizer"]["jwt"]["claims"]["email"]
        self.assertEqual(lambda_app.handler(no_email, None)["statusCode"], 403)

    def test_admin_cannot_lock_themselves_out(self):
        self.assertEqual(self.admin("PUT", "/api/admin/users", {"email": "boss@example.com", "enabled": False})[0], 400)
        self.assertEqual(self.admin("PUT", "/api/admin/users", {"email": "boss@example.com", "admin": False})[0], 400)
        self.assertEqual(self.admin("DELETE", "/api/admin/users", params={"email": "boss@example.com"})[0], 400)

    def test_cleanup_removes_only_old_unused_files(self):
        old = datetime.now(timezone.utc) - timedelta(days=1)
        self.s3.objects = {
            "files/aaaaaaaaaaaaaaaa/used.jpg": (10, old),
            "files/bbbbbbbbbbbbbbbb/in-draft.png": (20, old),
            "files/cccccccccccccccc/unused.mp4": (300, old),
            "files/dddddddddddddddd/just-uploaded.jpg": (40, datetime.now(timezone.utc)),
            "files/seed/example.jpg": (50, old),
        }
        call("PUT", "/api/tiddler", {"title": "Фото", "text": "[img[/files/aaaaaaaaaaaaaaaa/used.jpg]]"})
        call("PUT", "/api/state/draft", {"key": "Черновик", "text": "![x](/files/bbbbbbbbbbbbbbbb/in-draft.png)"}, email="other@example.com")
        status, found = self.admin("GET", "/api/admin/files")
        self.assertEqual([item["key"] for item in found["items"]], ["files/cccccccccccccccc/unused.mp4"])
        self.assertEqual(found["bytes"], 300)
        status, result = self.admin("POST", "/api/admin/files/cleanup", {"keys": ["files/cccccccccccccccc/unused.mp4", "files/aaaaaaaaaaaaaaaa/used.jpg"]})
        self.assertEqual(result["deleted"], ["files/cccccccccccccccc/unused.mp4"])
        self.assertEqual(result["skipped"], ["files/aaaaaaaaaaaaaaaa/used.jpg"])
        self.assertEqual(sorted(self.s3.objects), ["files/aaaaaaaaaaaaaaaa/used.jpg", "files/bbbbbbbbbbbbbbbb/in-draft.png", "files/dddddddddddddddd/just-uploaded.jpg", "files/seed/example.jpg"])


class HelpersTest(unittest.TestCase):
    def test_safe_file_name_keeps_extension(self):
        self.assertEqual(lambda_app.safe_file_name("../Фото отпуска 2024.JPG"), "2024.jpg")
        self.assertEqual(lambda_app.safe_file_name("my report (1).pdf"), "my-report-1.pdf")
        self.assertEqual(lambda_app.safe_file_name(""), "file")

    def test_cursor_round_trip(self):
        key = {"pk": "T#а", "sk": "CURRENT", "gsi1pk": "TIDDLER", "gsi1sk": "а"}
        self.assertEqual(lambda_app.decode_cursor(lambda_app.encode_cursor(key)), key)

    def test_viewer_host_skips_api_gateway(self):
        self.assertEqual(lambda_app.viewer_host({"headers": {"X-Viewer-Host": "wiki.example.com"}}), "wiki.example.com")
        self.assertEqual(lambda_app.viewer_host({"headers": {"x-viewer-host": "abc.execute-api.eu-central-1.amazonaws.com"}}), "")


class SigningTest(unittest.TestCase):
    def test_signature_matches_openssl(self):
        with tempfile.TemporaryDirectory() as tmp:
            key_path = os.path.join(tmp, "key.pem")
            subprocess.run(["openssl", "genrsa", "-traditional", "-out", key_path, "2048"], check=True, capture_output=True)
            with open(key_path) as handle:
                pem = handle.read()
            message = b'{"Statement":[]}'
            expected = subprocess.run(
                ["openssl", "dgst", "-sha1", "-sign", key_path],
                input=message, check=True, capture_output=True,
            ).stdout
            self.assertEqual(lambda_app.rsa_sha1_sign(message, lambda_app.load_rsa_private_key(pem)), expected)

    def test_pkcs8_key_is_accepted(self):
        with tempfile.TemporaryDirectory() as tmp:
            key_path = os.path.join(tmp, "key.pem")
            subprocess.run(["openssl", "genpkey", "-algorithm", "RSA", "-out", key_path], check=True, capture_output=True)
            with open(key_path) as handle:
                key = lambda_app.load_rsa_private_key(handle.read())
            self.assertEqual(key["p"] * key["q"], key["n"])

    def test_cookies_use_cloudfront_alphabet(self):
        os.environ["CLOUDFRONT_KEY_PAIR_ID"] = "K123"
        with tempfile.TemporaryDirectory() as tmp:
            key_path = os.path.join(tmp, "key.pem")
            subprocess.run(["openssl", "genrsa", "-traditional", "-out", key_path, "2048"], check=True, capture_output=True)
            with open(key_path) as handle:
                lambda_app._signing_key = lambda_app.load_rsa_private_key(handle.read())
        cookies = lambda_app.file_cookies("wiki.example.com", now=1000)
        policy = cookies[0].split(";")[0].split("=", 1)[1]
        self.assertNotRegex(policy, r"[+=/]")
        decoded = base64.b64decode(policy.replace("-", "+").replace("_", "=").replace("~", "/"))
        self.assertIn(b"https://wiki.example.com/files/*", decoded)
        self.assertIn(b"4600", decoded)
        self.assertTrue(all("Path=/files" in cookie for cookie in cookies))


if __name__ == "__main__":
    unittest.main()
