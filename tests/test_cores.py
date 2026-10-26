"""Этап 7: внешние расчётные ядра (М9), правило П12."""

import shutil

import pandas as pd
import pytest
from fastapi.testclient import TestClient

from field_twin import config, rules, storage
from field_twin.api import create_app
from field_twin.cores import base
from field_twin.cores.aerosim import AerosimCore
from field_twin.cores.stub import StubCore
from field_twin.cores.tnavigator import TNavigatorCore
from field_twin.cycle import CycleRunner, run_cycle

NOW = pd.Timestamp("2026-07-01T12:00:00Z")


def inp(**kw):
    m = {"absorber.A-1.Q_gas": 450.0, "absorber.A-2.Q_gas": 451.0, "absorber.A-2.L_cube": 280.0,
         "methanol.M-2.Q_methanol": 150.0}
    m.update({k.replace("__", "."): v for k, v in kw.items()})
    return base.CoreInput(NOW, m)


class OtherCore(base.CoreAdapter):
    """Другое ядро, подключаемое только через конфигурацию."""
    name = "other"

    def calculate(self, i):
        r = base.CoreResult(self.name, i.now, calculated={"x": 1.0})
        r.recommendations.append(base.Recommendation("other:1", "Совет другого ядра", "Сделать так", "A-1"))
        return r


class BrokenCore(base.CoreAdapter):
    def calculate(self, i):
        raise RuntimeError("ядро упало")


def test_registry_loads_stub_from_config():
    cores = base.load_cores(config.load_yaml("cores.yaml"))
    assert [c.name for c in cores] == ["stub"] and isinstance(cores[0], StubCore)
    all_cores = base.load_cores(config.load_yaml("cores.yaml"), only_enabled=False)
    assert {c.name for c in all_cores} == {"stub", "aerosim", "tnavigator"}


def test_stub_replaceable_without_code_change():
    # Критерий приёмки: заглушку можно заменить другим адаптером без правки остального кода.
    cfg = {"cores": [{"name": "other", "class": "test_cores:OtherCore", "enabled": True}]}
    cores = base.load_cores(cfg)
    res = base.run_cores(cores, inp())
    ev = rules.check_p12(res, config.thresholds(), NOW)
    assert [e.code for e in ev] == ["П12"] and "Совет другого ядра" in ev[0].message


def test_stub_recommendations():
    r = StubCore({"imbalance_pct": 3, "level_drop_pct": 10}).calculate(inp(absorber__A__1__Q_gas=0))
    assert r.recommendations == []
    r = StubCore({"imbalance_pct": 3}).calculate(inp(**{"absorber__A-1__Q_gas": 480.0}))
    assert [x.key for x in r.recommendations] == ["redistribute:A-1->A-2"]
    assert r.recommendations[0].changes[0].proposed == pytest.approx((480 + 451) / 2)
    r = StubCore({}).calculate(inp(**{"absorber__A-2__L_cube": 240.0}))
    assert [x.key for x in r.recommendations] == ["methanol:A-2"]


def test_aerosim_tnavigator_are_described_stubs():
    for cls in (AerosimCore, TNavigatorCore):
        core = cls()
        assert not core.is_available()
        with pytest.raises(NotImplementedError, match="Открытые вопросы"):
            core.calculate(inp())
        with pytest.raises(NotImplementedError):
            core.connect()
    res = base.run_cores([AerosimCore(), BrokenCore()], inp())
    assert [r.status for r in res] == ["not_connected", "error"]
    assert "ядро упало" in res[1].error


def test_p12_on_chief_screen_and_decision(ingested_db, tmp_path):
    # Критерий приёмки: рекомендация заглушки появляется на экране главного инженера через П12.
    db = tmp_path / "c.sqlite"
    shutil.copy(ingested_db, db)
    conn = storage.connect(db)
    runner = CycleRunner(conn, hydrate_model=False, chudin_model=False)
    runner.cores = base.load_cores({"cores": [{"name": "other", "class": "test_cores:OtherCore"}]})
    runner.step()
    runner.step()      # повторный цикл не дублирует рекомендацию
    c = TestClient(create_app(db))
    st = c.get("/api/state", params={"role": "chief_engineer"}).json()
    recs = [e for e in st["events"] if e["code"] == "П12"]
    assert len(recs) == 1 and recs[0]["kind"] == "recommendation" and "Совет другого ядра" in recs[0]["message"]
    assert not [e for e in c.get("/api/state", params={"role": "operator"}).json()["events"] if e["code"] == "П12"]
    r = c.post("/api/decision", json={"event_id": recs[0]["id"], "decision": "confirm", "reason_code": "other",
                                      "user_name": "Петров", "role": "chief_engineer", "comment": "введено в АСУ"})
    assert r.status_code == 200


def test_cycle_survives_broken_core(ingested_db, tmp_path):
    db = tmp_path / "b.sqlite"
    shutil.copy(ingested_db, db)
    res = run_cycle(storage.connect(db), cores=[BrokenCore()], hydrate_model=False, chudin_model=False, log=False)
    assert res.core_results[0].status == "error"
