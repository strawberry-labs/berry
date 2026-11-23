import importlib.util
from pathlib import Path
import unittest
from urllib.parse import unquote, urlsplit
from unittest.mock import patch

path = Path(__file__).resolve().parents[1] / "aws" / "run-database-job.py"
spec = importlib.util.spec_from_file_location("database_job", path)
job = importlib.util.module_from_spec(spec)
spec.loader.exec_module(job)


class ManagedOwnerTest(unittest.TestCase):
    url = "postgresql://owner:previous@db.example.test:5432/berry?sslmode=require"
    managed = {"username": "owner", "password": "a/b ?#@:%+"}

    def test_preserves_target_and_encodes_rotated_password(self):
        value = urlsplit(job.owner_connection(self.url, "db.example.test", "berry", self.managed))
        self.assertEqual(unquote(value.password), self.managed["password"])
        self.assertEqual((value.hostname, value.port, value.path, value.query),
                         ("db.example.test", 5432, "/berry", "sslmode=require"))

    def test_refuses_to_send_the_owner_credential_to_a_different_target(self):
        for endpoint, database, owner in [
            ("different.example.test", "berry", self.managed),
            ("db.example.test", "other", self.managed),
            ("db.example.test", "berry", {"username": "api", "password": "value"}),
        ]:
            with self.subTest(endpoint=endpoint, database=database, owner=owner["username"]):
                with self.assertRaises(ValueError):
                    job.owner_connection(self.url, endpoint, database, owner)

    def test_only_release_database_jobs_may_use_managed_credentials(self):
        with patch("sys.argv", ["job", "unused", "worker"]), patch.object(job.subprocess, "check_output") as fetch:
            with self.assertRaises(ValueError):
                job.main()
            fetch.assert_not_called()


if __name__ == "__main__":
    unittest.main()
