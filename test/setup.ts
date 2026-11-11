// Point the app's database client at the test database before anything imports it.
process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
