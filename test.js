const BASE_URL = process.env.BASE_URL || "http://localhost:3000";

async function request(path, options = {}) {
  const response = await fetch(`${BASE_URL}${path}`, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {})
    }
  });

  const body = await response.json().catch(() => null);
  return { status: response.status, body };
}

function pass(label, details = "") {
  console.log(`PASS - ${label}${details ? ` (${details})` : ""}`);
}

function fail(label, details = "") {
  console.log(`FAIL - ${label}${details ? ` (${details})` : ""}`);
}

function expect(label, condition, details = "") {
  if (condition) pass(label, details);
  else fail(label, details);
}

async function runScenario() {
  let resourceId;

  const create = await request("/resources", {
    method: "POST",
    body: JSON.stringify({ name: "Cinema Screen A", total_capacity: 5 })
  });

  resourceId = create.body?.id;
  expect(
    "1. Create a resource with capacity 5",
    create.status === 201 && create.body?.total_capacity === 5 && create.body?.available_capacity === 5,
    `status ${create.status}`
  );

  const reserveThree = await request(`/resources/${resourceId}/reservations`, {
    method: "POST",
    body: JSON.stringify({ reserver_name: "Ali", quantity: 3 })
  });

  expect(
    "2. Reserve 3 units - expect success",
    reserveThree.status === 201 && reserveThree.body?.resource?.available_capacity === 2,
    `status ${reserveThree.status}`
  );

  const reserveThreeMore = await request(`/resources/${resourceId}/reservations`, {
    method: "POST",
    body: JSON.stringify({ reserver_name: "Sara", quantity: 3 })
  });

  expect(
    "3. Reserve 3 more units - expect failure",
    reserveThreeMore.status === 409,
    `status ${reserveThreeMore.status}`
  );

  const reserveTwo = await request(`/resources/${resourceId}/reservations`, {
    method: "POST",
    body: JSON.stringify({ reserver_name: "Omar", quantity: 2 })
  });

  expect(
    "4. Reserve 2 units - expect success",
    reserveTwo.status === 201 && reserveTwo.body?.resource?.available_capacity === 0,
    `status ${reserveTwo.status}`
  );

  const reserveOne = await request(`/resources/${resourceId}/reservations`, {
    method: "POST",
    body: JSON.stringify({ reserver_name: "Noor", quantity: 1 })
  });

  expect(
    "5. Reserve 1 unit - expect failure",
    reserveOne.status === 409,
    `status ${reserveOne.status}`
  );

  const finalResource = await request(`/resources/${resourceId}`);
  console.log(
    `Final capacity: ${finalResource.body?.available_capacity}/${finalResource.body?.total_capacity} available`
  );
}

runScenario().catch((error) => {
  console.error("Test script failed:", error.message);
  process.exitCode = 1;
});
