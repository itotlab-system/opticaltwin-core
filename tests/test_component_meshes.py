"""Vectorised mesh extraction must match the per-point Gf reference exactly,
and the cross-request asset cache must not re-read an unchanged asset."""

import os

from pxr import Gf, Sdf, Usd, UsdGeom

from backend import components, payload


def _reference_meshes(component_prim):
    """The per-point implementation the NumPy version replaced."""
    meshes = []
    xcache = UsdGeom.XformCache()
    world_to_component = xcache.GetLocalToWorldTransform(component_prim).GetInverse()
    for prim in Usd.PrimRange(component_prim):
        if not prim.IsA(UsdGeom.Mesh):
            continue
        mesh = UsdGeom.Mesh(prim)
        mesh_to_world = xcache.GetLocalToWorldTransform(prim)
        points = []
        for p in mesh.GetPointsAttr().Get():
            q = world_to_component.Transform(mesh_to_world.Transform(Gf.Vec3d(*p)))
            points.append([round(float(q[0]), 6), round(float(q[1]), 6), round(float(q[2]), 6)])
        counts = mesh.GetFaceVertexCountsAttr().Get()
        faces = mesh.GetFaceVertexIndicesAttr().Get()
        triangles, offset = [], 0
        for count in counts:
            face = faces[offset:offset + count]
            for i in range(1, count - 1):
                triangles.extend([int(face[0]), int(face[i]), int(face[i + 1])])
            offset += count
        meshes.append((points, triangles))
    return meshes


def _stage_with_mixed_faces():
    stage = Usd.Stage.CreateInMemory()
    root = UsdGeom.Xform.Define(stage, "/Part")
    root.AddTranslateOp().Set(Gf.Vec3d(12.5, -3.0, 7.25))
    root.AddRotateZOp().Set(33.0)
    child = UsdGeom.Xform.Define(stage, "/Part/Sub")
    child.AddRotateXOp().Set(-71.0)
    child.AddScaleOp().Set(Gf.Vec3f(1.5, 0.75, 2.0))
    mesh = UsdGeom.Mesh.Define(stage, "/Part/Sub/Body")
    mesh.AddTranslateOp().Set(Gf.Vec3d(0.1, 0.2, 0.3))
    mesh.CreatePointsAttr([(0, 0, 0), (1, 0, 0), (1, 1, 0), (0, 1, 0),
                           (0.5, 1.7, 0.2), (0.3333, 0.1111, 0.9876)])
    # A quad, a degenerate 2-vertex face, a pentagon and a triangle.
    mesh.CreateFaceVertexCountsAttr([4, 2, 5, 3])
    mesh.CreateFaceVertexIndicesAttr([0, 1, 2, 3, 4, 5, 0, 1, 2, 4, 3, 5, 1, 2])
    tri = UsdGeom.Mesh.Define(stage, "/Part/Tri")
    tri.CreatePointsAttr([(0, 0, 0), (2, 0, 0), (0, 2, 0)])
    tri.CreateFaceVertexCountsAttr([3])
    tri.CreateFaceVertexIndicesAttr([0, 2, 1])
    return stage, stage.GetPrimAtPath("/Part")


def test_vectorised_meshes_match_per_point_reference():
    stage, part = _stage_with_mixed_faces()
    got = components._component_meshes(stage, part)
    want = _reference_meshes(part)
    assert [(m["points"], m["indices"]) for m in got] == want
    # Plain JSON types, not NumPy scalars, reach the response.
    assert type(got[0]["points"][0][0]) is float
    assert type(got[0]["indices"][0]) is int


def test_hi_asset_is_read_once_across_requests(tmp_path, monkeypatch):
    asset = tmp_path / "hi.usda"
    stage = Usd.Stage.CreateNew(str(asset))
    root = UsdGeom.Xform.Define(stage, "/Asset")
    stage.SetDefaultPrim(root.GetPrim())
    mesh = UsdGeom.Mesh.Define(stage, "/Asset/Body")
    mesh.CreatePointsAttr([(0, 0, 0), (1, 0, 0), (0, 1, 0)])
    mesh.CreateFaceVertexCountsAttr([3])
    mesh.CreateFaceVertexIndicesAttr([0, 1, 2])
    stage.GetRootLayer().Save()

    project = Usd.Stage.CreateInMemory()
    project.SetDefaultPrim(UsdGeom.Xform.Define(project, "/Setup").GetPrim())
    placed = project.DefinePrim("/Setup/Lens")
    placed.CreateAttribute("optics:type", Sdf.ValueTypeNames.Token).Set("lens")

    monkeypatch.setattr(payload, "_ASSET_CACHE", type(payload._ASSET_CACHE)())
    monkeypatch.setattr(payload, "_component_asset_name", lambda prim: "Lens/Asset")
    monkeypatch.setattr(payload.ol, "cad_library_assets", lambda lib: {"Lens/Asset"})
    monkeypatch.setattr(payload.uu, "get_component_usda_path", lambda *a: str(asset))

    reads = []
    original = components._component_mesh_arrays

    def counting(stage, prim, *, beam_only=False):
        reads.append(beam_only)
        return original(stage, prim, beam_only=beam_only)

    monkeypatch.setattr(components, "_component_mesh_arrays", counting)
    first = payload._project_components(project, "hi")
    second = payload._project_components(project, "hi")

    assert reads == [False]
    assert first[0]["meshes"] == second[0]["meshes"]
    assert first[0]["meshes"][0]["indices"] == [0, 1, 2]
    # Each response gets its own lists, so one request can't alter another's.
    assert first[0]["meshes"][0]["points"] is not second[0]["meshes"][0]["points"]

    # Re-importing the asset changes its mtime/size, which must miss the cache.
    # Bump the mtime explicitly: a rewrite within the same filesystem timestamp
    # tick would otherwise keep it, and the test would depend on timing.
    mesh.CreatePointsAttr([(0, 0, 0), (2, 0, 0), (0, 2, 0)])
    stage.GetRootLayer().Save()
    before = os.stat(asset).st_mtime_ns
    os.utime(asset, ns=(before + 1_000_000_000, before + 1_000_000_000))
    third = payload._project_components(project, "hi")
    assert reads == [False, False]
    assert third[0]["meshes"][0]["points"][1] == [2.0, 0.0, 0.0]
