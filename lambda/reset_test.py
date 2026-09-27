import json
import os
import re
import unittest

import reset

SEED = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "seed")


class FakeDynamo:
    def __init__(self, items):
        self.items = {(i["pk"]["S"], i["sk"]["S"]): i for i in items}

    def scan(self, TableName, ProjectionExpression, ExclusiveStartKey=None):
        keys = sorted(self.items)
        # Like DynamoDB, carry on after the last key even if it was deleted meanwhile.
        start = sum(1 for key in keys if ExclusiveStartKey and key <= ExclusiveStartKey)
        page = keys[start:start + 30]
        answer = {"Items": [{"pk": {"S": k[0]}, "sk": {"S": k[1]}} for k in page]}
        if start + 30 < len(keys):
            answer["LastEvaluatedKey"] = page[-1]
        return answer

    def batch_write_item(self, RequestItems):
        (requests,) = RequestItems.values()
        assert len(requests) <= 25
        for request in requests:
            if "PutRequest" in request:
                item = request["PutRequest"]["Item"]
                self.items[(item["pk"]["S"], item["sk"]["S"])] = item
            else:
                key = request["DeleteRequest"]["Key"]
                self.items.pop((key["pk"]["S"], key["sk"]["S"]))
        return {}


class Pager:
    def __init__(self, pages):
        self.pages = pages

    def paginate(self, **kwargs):
        return self.pages()


class FakeS3:
    def __init__(self):
        self.versions = [{"Key": f"files/{n}/a.jpg", "VersionId": f"v{n}"} for n in range(1500)]
        self.markers = [{"Key": "files/x/b.png", "VersionId": "m1"}]
        self.seed = [{"Key": "files/seed/example.jpg", "VersionId": "s1"}]

    def get_paginator(self, name):
        return Pager(lambda: [{"Versions": list(self.versions) + list(self.seed), "DeleteMarkers": list(self.markers)}])

    def delete_objects(self, Bucket, Delete):
        assert len(Delete["Objects"]) <= 1000
        gone = {(o["Key"], o["VersionId"]) for o in Delete["Objects"]}
        self.versions = [v for v in self.versions if (v["Key"], v["VersionId"]) not in gone]
        self.markers = [m for m in self.markers if (m["Key"], m["VersionId"]) not in gone]
        self.seed = [s for s in self.seed if (s["Key"], s["VersionId"]) not in gone]


class FakeCognito:
    def __init__(self, users):
        self.users = dict(users)
        self.calls = []

    def get_paginator(self, name):
        return Pager(lambda: [{"Users": [
            {"Username": u, "Attributes": [{"Name": "email", "Value": e}]} for u, e in self.users.items()
        ]}])

    def admin_delete_user(self, UserPoolId, Username):
        del self.users[Username]

    def admin_create_user(self, UserPoolId, Username, UserAttributes, MessageAction):
        self.users[Username] = Username
        self.calls.append(("create", Username, MessageAction))

    def admin_set_user_password(self, **kwargs):
        self.calls.append(("password", kwargs["Username"], kwargs["Password"], kwargs["Permanent"]))

    def admin_enable_user(self, **kwargs):
        self.calls.append(("enable", kwargs["Username"]))

    def admin_add_user_to_group(self, **kwargs):
        self.calls.append(("group", kwargs["Username"], kwargs["GroupName"]))

    def admin_user_global_sign_out(self, **kwargs):
        self.calls.append(("sign_out", kwargs["Username"]))


class FakeSsm:
    def get_parameter(self, Name, WithDecryption):
        return {"Parameter": {"Value": "admin123"}}


class ResetTest(unittest.TestCase):
    def setUp(self):
        os.environ.update(TABLE_NAME="wiki", FILES_BUCKET="files", USER_POOL_ID="pool",
                          ADMIN_EMAIL="admin@example.com", ADMIN_PASSWORD_PARAMETER="/wiki/admin-password", ADMIN_GROUP="admins")
        items = [{"pk": {"S": f"T#{n}"}, "sk": {"S": "CURRENT"}} for n in range(70)]
        items += [{"pk": {"S": "U#guest@example.com"}, "sk": {"S": "STORY"}}]
        self.ddb, self.s3, self.ssm = FakeDynamo(items), FakeS3(), FakeSsm()
        self.cognito = FakeCognito({"uuid-admin": "Admin@Example.com", "uuid-guest": "guest@example.com"})
        reset._clients.update({"dynamodb": self.ddb, "s3": self.s3, "cognito-idp": self.cognito, "ssm": self.ssm})
        reset.SEED_FILE = os.path.join(SEED, "tiddlers.json")
        with open(reset.SEED_FILE, encoding="utf-8") as source:
            self.seed = json.load(source)

    def test_wipes_data_files_and_other_users(self):
        result = reset.handler({}, None)
        self.assertEqual(result["items"], 71)
        self.assertFalse([key for key in self.ddb.items if key[0] in ("T#0", "U#guest@example.com")])
        self.assertEqual(result["files"], 1501)
        self.assertEqual((self.s3.versions, self.s3.markers), ([], []))
        self.assertEqual(self.s3.seed, [{"Key": "files/seed/example.jpg", "VersionId": "s1"}])
        self.assertEqual(self.cognito.users, {"uuid-admin": "Admin@Example.com"})
        self.assertEqual(result["users"], {"removed": 1, "admin_recreated": False})
        self.assertIn(("password", "admin@example.com", "admin123", True), self.cognito.calls)
        self.assertIn(("group", "admin@example.com", "admins"), self.cognito.calls)
        self.assertEqual(self.cognito.calls[-1], ("sign_out", "admin@example.com"))

    def test_recreates_a_deleted_admin(self):
        self.cognito.users = {"uuid-guest": "guest@example.com"}
        result = reset.handler({}, None)
        self.assertTrue(result["users"]["admin_recreated"])
        self.assertIn(("create", "admin@example.com", "SUPPRESS"), self.cognito.calls)

    def test_writes_the_example_tiddlers(self):
        result = reset.handler({}, None)
        self.assertEqual(result["seeded"], len(self.seed))
        current = {k[0]: v for k, v in self.ddb.items.items() if k[1] == "CURRENT"}
        revisions = [k for k in self.ddb.items if k[1].startswith("REV#")]
        self.assertEqual(sorted(current), sorted("T#" + t["title"] for t in self.seed))
        self.assertEqual(len(revisions), len(self.seed))
        plans = current["T#Weekend plans"]
        self.assertEqual(plans["gsi1pk"], {"S": "TIDDLER"})
        self.assertEqual(plans["creator"], {"S": "admin@example.com"})
        self.assertIn({"S": "Orange tree"}, plans["links"]["L"])
        self.assertGreater(int(plans["size"]["N"]), 0)

    def test_example_files_exist(self):
        used = {path for t in self.seed for path in re.findall(r"/files/seed/([^\]\s|]+)", t["text"])}
        self.assertTrue(used)
        self.assertLessEqual(used, set(os.listdir(os.path.join(SEED, "files"))))
        for t in self.seed:
            for target in re.findall(r"\[\[(?:[^|\]]*\|)?([^\]]+)\]\]", t["text"]):
                if not target.startswith(("http", "$:/")):
                    self.assertIn(target, {s["title"] for s in self.seed}, t["title"])

    def test_no_seed_file_means_no_examples(self):
        reset.SEED_FILE = os.path.join(SEED, "missing.json")
        result = reset.handler({}, None)
        self.assertEqual(result["seeded"], 0)
        self.assertEqual(self.ddb.items, {})

    def test_empty_site_is_fine(self):
        self.ddb.items, self.s3.versions, self.s3.markers = {}, [], []
        self.cognito.users = {"uuid-admin": "admin@example.com"}
        result = reset.handler({}, None)
        self.assertEqual((result["items"], result["files"]), (0, 0))


if __name__ == "__main__":
    unittest.main()
