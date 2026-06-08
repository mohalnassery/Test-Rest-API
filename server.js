import http from "node:http";
import { URL } from "node:url";
import sqlite3 from "sqlite3";

const PORT = Number(process.env.PORT || 3000);
const DB_FILE = process.env.DB_FILE || "inventory.db";

const sqlite = sqlite3.verbose();
const db = new sqlite.Database(DB_FILE);

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (error) {
      if (error) reject(error);
      else resolve({ lastID: this.lastID, changes: this.changes });
    });
    
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (error, row) => {
      if (error) reject(error);
      else resolve(row);
    });
  });


}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (error, rows) => {
      if (error) reject(error);
      else resolve(rows);
    });
  });
}

await run("PRAGMA foreign_keys = ON");
await run(`
  CREATE TABLE IF NOT EXISTS resources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    total_capacity INTEGER NOT NULL CHECK (total_capacity > 0),
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
  )
`);
await run(`
  CREATE TABLE IF NOT EXISTS reservations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    resource_id INTEGER NOT NULL,
    reserver_name TEXT NOT NULL,
    quantity INTEGER NOT NULL CHECK (quantity > 0),
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (resource_id) REFERENCES resources(id)
  )
`);

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function sendJson(response, statusCode, data) {
  response.writeHead(statusCode, { "Content-Type": "application/json" });
  response.end(JSON.stringify(data));
}

function readJson(request) {
  return new Promise((resolve, reject) => {
    let body = "";
    request.on("data", (chunk) => {
      body += chunk;
    });
    request.on("end", () => {
      try {
        resolve(body ? JSON.parse(body) : {});
      } catch (error) {
        reject(error);
      }
    });
    request.on("error", reject);
  });
}

async function getResourceDetails(resourceId) {
  return get(
    `
      SELECT
        r.id,
        r.name,
        r.total_capacity,
        r.created_at,
        r.total_capacity - COALESCE(SUM(CASE WHEN rv.status = 'active' THEN rv.quantity ELSE 0 END), 0) AS available_capacity
      FROM resources r
      LEFT JOIN reservations rv ON rv.resource_id = r.id
      WHERE r.id = ?
      GROUP BY r.id
    `,
    [resourceId]
  );
}

async function createResource(request, response) {
  const body = await readJson(request);
  const name = typeof body.name === "string" ? body.name.trim() : "";
  const totalCapacity = body.total_capacity;

  if (!name) {
    return sendJson(response, 400, { error: "name is required" });
  }

  if (!isPositiveInteger(totalCapacity)) {
    return sendJson(response, 400, { error: "the total capacity must be a positive integer" });
  }

  const result = await run(
    "INSERT INTO resources (name, total_capacity) VALUES (?, ?)",
    [name, totalCapacity]
  );
  const resource = await getResourceDetails(result.lastID);

  return sendJson(response, 201, resource);
}

async function showResource(resourceId, response) {
  const resource = await getResourceDetails(resourceId);

  if (!resource) {
    return sendJson(response, 404, { error: "resource not found" });
  }

  return sendJson(response, 200, resource);
}

async function createReservation(resourceId, request, response) {
  const body = await readJson(request);
  const reserverName = typeof body.reserver_name === "string" ? body.reserver_name.trim() : "";
  const quantity = body.quantity;

  if (!reserverName) {
    return sendJson(response, 400, { error: "reserver_name is required" });
  }

  if (!isPositiveInteger(quantity)) {
    return sendJson(response, 400, { error: "quantity must be a positive integer" });
  }

  await run("BEGIN IMMEDIATE TRANSACTION");

  try {
    const resource = await getResourceDetails(resourceId);

    if (!resource) {
      await run("ROLLBACK");
      return sendJson(response, 404, { error: "resource not found" });
    }

    if (quantity > resource.available_capacity) {
      await run("ROLLBACK");
      return sendJson(response, 409, {
        error: "reservation exceeds available capacity",
        available_capacity: resource.available_capacity,
        requested_quantity: quantity
      });
    }

    const result = await run(
      `
        INSERT INTO reservations (resource_id, reserver_name, quantity)
        VALUES (?, ?, ?)
      `,
      [resourceId, reserverName, quantity]
    );
    await run("COMMIT");

    const reservation = await get(
      `
        SELECT id, resource_id, reserver_name, quantity, status, created_at
        FROM reservations
        WHERE id = ?
      `,
      [result.lastID]
    );
    const updatedResource = await getResourceDetails(resourceId);

    return sendJson(response, 201, { reservation, resource: updatedResource });
  } catch (error) {
    await run("ROLLBACK");
    throw error;
  }
}

async function listReservations(resourceId, response) {
  const resource = await get("SELECT id FROM resources WHERE id = ?", [resourceId]);

  if (!resource) {
    return sendJson(response, 404, { error: "resource not found" });
  }

  const reservations = await all(
    `
      SELECT id, resource_id, reserver_name, quantity, status, created_at
      FROM reservations
      WHERE resource_id = ? AND status = 'active'
      ORDER BY id ASC
    `,
    [resourceId]
  );

  return sendJson(response, 200, reservations);
}

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url, `http://${request.headers.host}`);
    const parts = url.pathname.split("/").filter(Boolean); 

    const isResources = parts[0] === "resources";
    
    // POST /resources
    if (request.method === "POST" && parts.length === 1 && isResources) {
      return await createResource(request, response);
    }

    // GET /resources/:id
    if (request.method === "GET" && parts.length === 2 && isResources) {
      const resourceId = Number(parts[1]);
      if (Number.isNaN(resourceId)) {
        return sendJson(response, 400, { error: "invalid resource id" });
      }
      return await showResource(resourceId, response);
    }

    // POST /resources/:id/reservations
    if (request.method === "POST" && parts.length === 3 && isResources && parts[2] === "reservations") {
      const resourceId = Number(parts[1]);
      if (Number.isNaN(resourceId)) {
        return sendJson(response, 400, { error: "invalid resource id" });
      }
      return await createReservation(resourceId, request, response);
    }

    // GET /resources/:id/reservations
    if (request.method === "GET" && parts.length === 3 && isResources && parts[2] === "reservations") {
      const resourceId = Number(parts[1]);
      if (Number.isNaN(resourceId)) {
        return sendJson(response, 400, { error: "invalid resource id" });
      }
      return await listReservations(resourceId, response);
    }

    return sendJson(response, 404, { error: "route not found" });
  } catch (error) {
    if (error instanceof SyntaxError) {
      return sendJson(response, 400, { error: "invalid JSON body" });
    }

    console.error(error);
    return sendJson(response, 500, { error: "internal server error" });
  }
});

server.listen(PORT, () => {
  console.log(`Inventory Reservation API running on http://localhost:${PORT}`);
});
