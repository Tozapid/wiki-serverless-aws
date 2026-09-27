import os
import unittest

import reset


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

    def get_paginator(self, name):
        return Pager(lambda: [{"Versions": list(self.versions), "DeleteMarkers": list(self.markers)}])

    def delete_objects(self, Bucket, Delete):
        assert len(Delete["Objects"]) <= 1000
        gone = {(o["Key"], o["VersionId"]) for o in Delete["Objects"]}
        self.versions = [v for v in self.versions if (v["Key"], v["VersionId"]) not in gone]
        self.markers = [m for m in self.markers if (m["Key"], m["VersionId"]) not in gone]


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

    def test_wipes_data_files_and_other_users(self):
        result = reset.handler({}, None)
        self.assertEqual(result["items"], 71)
        self.assertEqual(self.ddb.items, {})
        self.assertEqual(result["files"], 1501)
        self.assertEqual((self.s3.versions, self.s3.markers), ([], []))
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

    def test_empty_site_is_fine(self):
        self.ddb.items, self.s3.versions, self.s3.markers = {}, [], []
        self.cognito.users = {"uuid-admin": "admin@example.com"}
        result = reset.handler({}, None)
        self.assertEqual((result["items"], result["files"]), (0, 0))


if __name__ == "__main__":
    unittest.main()
