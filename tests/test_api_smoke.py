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


def test_presenter_flow_over_http(db) -> None:
    client = make_client(db)

    competition = client.post(
        "/api/competitions", json={"name": "Comp Presenter HTTP", "eventDate": "2026-09-09", "judgeCount": 1}
    ).json()
    competitor = client.post(
        f"/api/competitions/{competition['id']}/competitors",
        json={"firstName": "Alice", "lastName": "Martin", "runningOrder": 1},
    ).json()

    activate_response = client.post(
        "/api/presenter/active", json={"competitionId": competition["id"], "competitorId": competitor["id"]}
    )
    assert activate_response.status_code == 200
    assert activate_response.json()["activePassage"]["id"] == competitor["id"]

    state_response = client.get("/api/presenter/state")
    assert state_response.status_code == 200
    assert state_response.json()["activePassage"]["id"] == competitor["id"]

    finalize_response = client.post(
        "/api/presenter/finalize", json={"competitionId": competition["id"], "competitorId": competitor["id"]}
    )
    assert finalize_response.status_code == 200

    bootstrap_response = client.get("/api/bootstrap")
    assert bootstrap_response.status_code == 200
    bootstrap_body = bootstrap_response.json()
    assert "dashboard" in bootstrap_body
    assert any(item["id"] == competition["id"] for item in bootstrap_body["competitions"])


def test_db_export_import_round_trip_over_http(db, other_db) -> None:
    source_client = make_client(db)
    source_client.post("/api/competitions", json={"name": "Comp DB HTTP", "eventDate": "2026-09-17"})

    export_response = source_client.get("/api/db/export")
    assert export_response.status_code == 200
    assert export_response.headers["content-type"] == "application/vnd.sqlite3"

    target_client = make_client(other_db)
    import_response = target_client.post(
        "/api/db/import", content=export_response.content, headers={"Content-Type": "application/octet-stream"}
    )
    assert import_response.status_code == 200
    assert import_response.json()["counts"]["competitions"] == 1

    list_response = target_client.get("/api/competitions")
    assert any(item["name"] == "Comp DB HTTP" for item in list_response.json())


def test_sync_export_import_round_trip_over_http(db, other_db) -> None:
    source_client = make_client(db)
    source_client.post("/api/competitions", json={"name": "Comp Sync HTTP", "eventDate": "2026-09-18"})

    export_response = source_client.get("/api/sync/export")
    assert export_response.status_code == 200

    target_client = make_client(other_db)
    import_response = target_client.post("/api/sync/import", json=export_response.json())
    assert import_response.status_code == 200
    assert import_response.json()["snapshotImported"]["competitions"] == 1

    list_response = target_client.get("/api/competitions")
    assert any(item["name"] == "Comp Sync HTTP" for item in list_response.json())


def test_pdf_export_rejected_from_non_loopback_client(db) -> None:
    client = make_client(db)
    response = client.post("/api/pdf/export", json={"type": "scoring_sheets", "competitionId": "whatever"})
    assert response.status_code == 400
    assert "poste local" in response.json()["error"]


def test_pdf_list_and_browse_empty(db) -> None:
    client = make_client(db)

    list_response = client.get("/api/pdf/list", params={"type": "scoring_sheets"})
    assert list_response.status_code == 200
    assert list_response.json()["files"] == []

    browse_response = client.get("/api/pdf/browse", params={"type": "scoring_sheets"})
    assert browse_response.status_code == 200
    assert "text/html" in browse_response.headers["content-type"]
