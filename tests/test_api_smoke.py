from __future__ import annotations

from fastapi.testclient import TestClient

from pole_scoring.api.deps import get_database
from pole_scoring.app import create_app
from pole_scoring.db.bootstrap import run_startup_tasks


def make_client(db) -> TestClient:
    run_startup_tasks(db)
    app = create_app()
    app.dependency_overrides[get_database] = lambda: db
    return TestClient(app)


def test_health_endpoint(db) -> None:
    client = make_client(db)
    response = client.get("/api/health")
    assert response.status_code == 200
    body = response.json()
    assert body["status"] == "ok"
    assert "nodeId" in body
    assert body["counts"]["competitions"] == 0


def test_static_index_is_served(db) -> None:
    client = make_client(db)
    response = client.get("/")
    assert response.status_code == 200
    assert "text/html" in response.headers["content-type"]


def test_competition_crud_over_http(db) -> None:
    client = make_client(db)

    create_response = client.post(
        "/api/competitions", json={"name": "Comp HTTP", "eventDate": "2026-05-01", "judgeCount": 3}
    )
    assert create_response.status_code == 201
    competition = create_response.json()
    assert competition["name"] == "Comp HTTP"

    list_response = client.get("/api/competitions")
    assert list_response.status_code == 200
    assert any(item["id"] == competition["id"] for item in list_response.json())

    missing_name_response = client.post("/api/competitions", json={"eventDate": "2026-05-02"})
    assert missing_name_response.status_code == 400
    assert "error" in missing_name_response.json()

    delete_response = client.request(
        "DELETE", f"/api/competitions/{competition['id']}", json={}
    )
    assert delete_response.status_code == 200
    assert delete_response.json() == {"deletedCompetitionId": competition["id"]}


def test_judge_crud_over_http(db) -> None:
    client = make_client(db)

    create_response = client.post(
        "/api/judges", json={"firstName": "Alice", "lastName": "Martin", "login": "alice", "password": "secret"}
    )
    assert create_response.status_code == 201
    judge = create_response.json()

    duplicate_response = client.post(
        "/api/judges", json={"firstName": "Bob", "lastName": "D", "login": "alice", "password": "secret2"}
    )
    assert duplicate_response.status_code == 400

    delete_response = client.delete(f"/api/judges/{judge['id']}")
    assert delete_response.status_code == 200


def test_access_bootstrap_and_role_protected_route(db) -> None:
    client = make_client(db)

    bootstrap_response = client.post(
        "/api/access/bootstrap-super-admin",
        json={"firstName": "Admin", "lastName": "Principal", "login": "admin", "password": "secret123"},
    )
    assert bootstrap_response.status_code == 201
    token = bootstrap_response.json()["token"]

    unauthenticated_response = client.get("/api/access/accounts")
    assert unauthenticated_response.status_code == 400

    authenticated_response = client.get("/api/access/accounts", headers={"x-access-token": token})
    assert authenticated_response.status_code == 200
    assert len(authenticated_response.json()) == 1


def test_scoring_and_notation_flow_over_http(db) -> None:
    client = make_client(db)

    competition = client.post(
        "/api/competitions", json={"name": "Comp Notation HTTP", "eventDate": "2026-09-08", "judgeCount": 1}
    ).json()
    judge = client.post(
        "/api/judges", json={"firstName": "Head", "lastName": "Judge", "login": "head", "password": "secret"}
    ).json()
    competitor = client.post(
        f"/api/competitions/{competition['id']}/competitors",
        json={"firstName": "Jeanne", "lastName": "Dupont", "runningOrder": 1},
    ).json()

    assignment_response = client.post(
        f"/api/competitions/{competition['id']}/judge-assignments",
        json={"slotIndex": 1, "judgeRole": "head", "judgeId": judge["id"]},
    )
    assert assignment_response.status_code == 200
    assert assignment_response.json()[0]["judgeId"] == judge["id"]

    grids_response = client.get("/api/scoring/grids")
    assert grids_response.status_code == 400  # non authentifie

    manual_save_response = client.post(
        "/api/manual-scoring/save",
        json={
            "competitionId": competition["id"],
            "competitorId": competitor["id"],
            "entries": [
                {"judgeId": judge["id"], "criterion": f"technical:{i}", "score": 4} for i in range(1, 7)
            ],
        },
    )
    assert manual_save_response.status_code == 200
    assert manual_save_response.json()["savedCount"] == 6

    results_response = client.get(f"/api/competitions/{competition['id']}/results")
    assert results_response.status_code == 200
    body = results_response.json()
    assert any(item["id"] == competitor["id"] for item in body["results"])
