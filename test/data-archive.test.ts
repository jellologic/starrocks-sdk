import { describe, test, expect, beforeAll, afterAll } from "bun:test";
import {
  createDataArchiveClient,
  createStarRocksClient,
  type DataArchiveClient,
  type StarRocksClient,
  type ArchiveOptions,
  type S3Destination,
  type HDFSDestination,
} from "../src";
import { testConfig, TEST_DATABASE } from "../src/test-config";

describe("DataArchiveClient", () => {
  let archiver: DataArchiveClient;
  let client: StarRocksClient;

  beforeAll(async () => {
    client = createStarRocksClient(testConfig);
    archiver = createDataArchiveClient(testConfig);

    await client.createDatabase(TEST_DATABASE);
    await client.useDatabase(TEST_DATABASE);

    // Create a test table for archive tests
    await client.execute(`
      CREATE TABLE IF NOT EXISTS archive_test (
        id BIGINT NOT NULL,
        event_date DATE,
        name VARCHAR(255),
        value DOUBLE
      ) PRIMARY KEY (id)
      DISTRIBUTED BY HASH(id) BUCKETS 4
      PROPERTIES ('replication_num'='1')
    `);

    // Insert some test data
    await client.execute(`
      INSERT INTO archive_test VALUES
        (1, '2024-01-15', 'Event1', 100.0),
        (2, '2024-01-16', 'Event2', 200.0),
        (3, '2024-02-15', 'Event3', 300.0)
    `);
  });

  afterAll(async () => {
    await archiver.close();
    await client.dropDatabase(TEST_DATABASE);
    await client.close();
  });

  describe("SQL Generation", () => {
    test("should generate basic S3 INSERT INTO FILES SQL", () => {
      const options: ArchiveOptions = {
        query: "SELECT * FROM test_table",
        destination: {
          type: "s3",
          path: "s3://mybucket/archive/",
          credentials: {
            accessKey: "AKIATEST",
            secretKey: "secretkey123",
            region: "us-west-2",
          },
        } as S3Destination,
        format: "parquet",
      };

      // Access private method via any cast for testing
      const sql = (archiver as any).buildInsertIntoFilesSQL(options);

      expect(sql).toContain('INSERT INTO FILES(');
      expect(sql).toContain('"path" = "s3://mybucket/archive/"');
      expect(sql).toContain('"format" = "parquet"');
      expect(sql).toContain('"aws.s3.access_key" = "AKIATEST"');
      expect(sql).toContain('"aws.s3.secret_key" = "secretkey123"');
      expect(sql).toContain('"aws.s3.region" = "us-west-2"');
      expect(sql).toContain('SELECT * FROM test_table');
    });

    test("should generate S3 SQL with compression", () => {
      const options: ArchiveOptions = {
        query: "SELECT * FROM test_table",
        destination: {
          type: "s3",
          path: "s3://mybucket/archive/",
          credentials: {
            accessKey: "AKIATEST",
            secretKey: "secret",
            region: "us-east-1",
          },
        } as S3Destination,
        format: "parquet",
        compression: "zstd",
      };

      const sql = (archiver as any).buildInsertIntoFilesSQL(options);

      expect(sql).toContain('"compression" = "zstd"');
    });

    test("should generate S3 SQL with partition_by", () => {
      const options: ArchiveOptions = {
        query: "SELECT * FROM test_table",
        destination: {
          type: "s3",
          path: "s3://mybucket/archive/",
          credentials: {
            accessKey: "AKIATEST",
            secretKey: "secret",
            region: "us-east-1",
          },
        } as S3Destination,
        format: "parquet",
        partitionBy: "event_date",
      };

      const sql = (archiver as any).buildInsertIntoFilesSQL(options);

      expect(sql).toContain('"partition_by" = "event_date"');
    });

    test("should generate S3 SQL with multiple partition columns", () => {
      const options: ArchiveOptions = {
        query: "SELECT * FROM test_table",
        destination: {
          type: "s3",
          path: "s3://mybucket/archive/",
          credentials: {
            accessKey: "AKIATEST",
            secretKey: "secret",
            region: "us-east-1",
          },
        } as S3Destination,
        format: "parquet",
        partitionBy: ["year", "month"],
      };

      const sql = (archiver as any).buildInsertIntoFilesSQL(options);

      expect(sql).toContain('"partition_by" = "year, month"');
    });

    test("should generate S3 SQL with custom endpoint for MinIO", () => {
      const options: ArchiveOptions = {
        query: "SELECT * FROM test_table",
        destination: {
          type: "s3",
          path: "s3://mybucket/archive/",
          credentials: {
            accessKey: "minioadmin",
            secretKey: "minioadmin",
            region: "us-east-1",
            endpoint: "http://localhost:9000",
          },
        } as S3Destination,
        format: "parquet",
      };

      const sql = (archiver as any).buildInsertIntoFilesSQL(options);

      expect(sql).toContain('"aws.s3.endpoint" = "http://localhost:9000"');
    });

    test("should generate S3 SQL with max file size", () => {
      const options: ArchiveOptions = {
        query: "SELECT * FROM test_table",
        destination: {
          type: "s3",
          path: "s3://mybucket/archive/",
          credentials: {
            accessKey: "AKIATEST",
            secretKey: "secret",
            region: "us-east-1",
          },
        } as S3Destination,
        format: "parquet",
        maxFileSize: 1073741824, // 1GB
      };

      const sql = (archiver as any).buildInsertIntoFilesSQL(options);

      expect(sql).toContain('"target_max_file_size" = "1073741824"');
    });

    test("should generate HDFS INSERT INTO FILES SQL", () => {
      const options: ArchiveOptions = {
        query: "SELECT * FROM test_table",
        destination: {
          type: "hdfs",
          path: "hdfs://namenode:9000/archive/",
          credentials: {
            username: "hadoop",
            password: "hadoop123",
          },
        } as HDFSDestination,
        format: "orc",
      };

      const sql = (archiver as any).buildInsertIntoFilesSQL(options);

      expect(sql).toContain('"path" = "hdfs://namenode:9000/archive/"');
      expect(sql).toContain('"format" = "orc"');
      expect(sql).toContain('"hadoop.security.authentication" = "simple"');
      expect(sql).toContain('"username" = "hadoop"');
      expect(sql).toContain('"password" = "hadoop123"');
    });

    test("should generate CSV format SQL", () => {
      const options: ArchiveOptions = {
        query: "SELECT * FROM test_table",
        destination: {
          type: "s3",
          path: "s3://mybucket/archive/",
          credentials: {
            accessKey: "AKIATEST",
            secretKey: "secret",
            region: "us-east-1",
          },
        } as S3Destination,
        format: "csv",
        compression: "gzip",
      };

      const sql = (archiver as any).buildInsertIntoFilesSQL(options);

      expect(sql).toContain('"format" = "csv"');
      expect(sql).toContain('"compression" = "gzip"');
    });
  });

  describe("Path Template Expansion", () => {
    test("should expand {year} placeholder", () => {
      const date = new Date("2024-06-15");
      const result = (archiver as any).expandPathTemplate(
        "s3://bucket/archive/{year}/",
        date
      );

      expect(result).toBe("s3://bucket/archive/2024/");
    });

    test("should expand {month} placeholder with zero padding", () => {
      const date = new Date("2024-03-15");
      const result = (archiver as any).expandPathTemplate(
        "s3://bucket/archive/{month}/",
        date
      );

      expect(result).toBe("s3://bucket/archive/03/");
    });

    test("should expand {day} placeholder with zero padding", () => {
      const date = new Date("2024-03-05");
      const result = (archiver as any).expandPathTemplate(
        "s3://bucket/archive/{day}/",
        date
      );

      expect(result).toBe("s3://bucket/archive/05/");
    });

    test("should expand {date} placeholder", () => {
      const date = new Date("2024-06-15");
      const result = (archiver as any).expandPathTemplate(
        "s3://bucket/archive/{date}/",
        date
      );

      expect(result).toBe("s3://bucket/archive/2024-06-15/");
    });

    test("should expand multiple placeholders", () => {
      const date = new Date("2024-06-15");
      const result = (archiver as any).expandPathTemplate(
        "s3://bucket/archive/{year}/{month}/{day}/",
        date
      );

      expect(result).toBe("s3://bucket/archive/2024/06/15/");
    });

    test("should handle templates without placeholders", () => {
      const date = new Date("2024-06-15");
      const result = (archiver as any).expandPathTemplate(
        "s3://bucket/archive/static/",
        date
      );

      expect(result).toBe("s3://bucket/archive/static/");
    });
  });

  describe("Policy Definition", () => {
    test("should define policy and convert to archive options", () => {
      const policy = archiver.definePolicy({
        name: "archive-old-events",
        source: {
          database: "mydb",
          table: "events",
          filter: "created_at < '2024-01-01'",
        },
        destination: {
          type: "s3",
          path: "s3://mybucket/archive/events/",
          credentials: {
            accessKey: "AKIATEST",
            secretKey: "secret",
            region: "us-west-2",
          },
        },
        format: "parquet",
        compression: "zstd",
      });

      expect(policy.name).toBe("archive-old-events");

      const options = policy.toArchiveOptions();

      expect(options.query).toBe(
        "SELECT * FROM mydb.events WHERE created_at < '2024-01-01'"
      );
      expect(options.format).toBe("parquet");
      expect(options.compression).toBe("zstd");
      expect(options.destination.path).toBe("s3://mybucket/archive/events/");
    });

    test("should define policy with specific columns", () => {
      const policy = archiver.definePolicy({
        name: "archive-subset",
        source: {
          database: "mydb",
          table: "events",
          columns: ["id", "name", "created_at"],
        },
        destination: {
          type: "s3",
          path: "s3://mybucket/archive/",
          credentials: {
            accessKey: "AKIATEST",
            secretKey: "secret",
            region: "us-west-2",
          },
        },
        format: "parquet",
      });

      const options = policy.toArchiveOptions();

      expect(options.query).toBe("SELECT id, name, created_at FROM mydb.events");
    });

    test("should expand path template when converting to options", () => {
      const policy = archiver.definePolicy({
        name: "archive-with-template",
        source: {
          database: "mydb",
          table: "events",
        },
        destination: {
          type: "s3",
          path: "s3://mybucket/archive/",
          pathTemplate: "s3://mybucket/archive/{year}/{month}/",
          credentials: {
            accessKey: "AKIATEST",
            secretKey: "secret",
            region: "us-west-2",
          },
        },
        format: "parquet",
      });

      const date = new Date("2024-06-15");
      const options = policy.toArchiveOptions(date);

      expect(options.destination.path).toBe("s3://mybucket/archive/2024/06/");
    });
  });

  describe("Purge Safety", () => {
    test("should throw error when filter is empty", async () => {
      await expect(
        archiver.purgeArchived({
          database: TEST_DATABASE,
          table: "archive_test",
          filter: "",
        })
      ).rejects.toThrow("Filter is required");
    });

    test("should throw error when filter is whitespace only", async () => {
      await expect(
        archiver.purgeArchived({
          database: TEST_DATABASE,
          table: "archive_test",
          filter: "   ",
        })
      ).rejects.toThrow("Filter is required");
    });

    test("should perform dry run and return count", async () => {
      const result = await archiver.purgeArchived({
        database: TEST_DATABASE,
        table: "archive_test",
        filter: "event_date < '2024-02-01'",
        dryRun: true,
      });

      expect(result.dryRun).toBe(true);
      expect(result.deletedRows).toBe(2); // Events from January
    });
  });
});
