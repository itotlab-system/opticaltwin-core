"""Where a component sits: transforms, the height clamp, holder/post links,
and re-pointing relative asset references when parts are copied."""

import os
import re
import math

from pxr import Usd, UsdGeom, Gf, Sdf

from opticaltwin import usd_utility as uu

from backend import config

Z_MAX_MM = 300.0        # component height ceiling; mirrors the app's drag limit

def _xform_values(prim):
    xf = UsdGeom.Xformable(prim)
    x = y = z = rot_x = rot_y = rot_z = 0.0
    for op in xf.GetOrderedXformOps():
        n = op.GetOpName()
        if n == "xformOp:translate":
            v = op.Get()
            if v:
                x, y, z = float(v[0]), float(v[1]), float(v[2])
        elif n == "xformOp:rotateX":
            rot_x = float(op.Get() or 0.0)
        elif n == "xformOp:rotateY":
            rot_y = float(op.Get() or 0.0)
        elif n == "xformOp:rotateZ":
            rot_z = float(op.Get() or 0.0)
    return x, y, z, rot_x, rot_y, rot_z

def _placement_xform_values(prim):
    """Return only transforms authored by the project placement layer.

    A referenced component asset can author its own root rotation to define
    the model's canonical pose.  Reading the composed prim with
    ``_xform_values`` would expose that asset rotation as a placement rotation
    as well, causing the viewport to apply it twice.
    """
    root_layer = prim.GetStage().GetRootLayer()
    spec = root_layer.GetPrimAtPath(prim.GetPath())
    if spec is None:
        return 0.0, 0.0, 0.0, 0.0, 0.0, 0.0

    def authored(name, default):
        attribute = spec.attributes.get(name)
        value = attribute.default if attribute is not None else None
        return default if value is None else value

    translate = authored("xformOp:translate", (0.0, 0.0, 0.0))
    return (
        float(translate[0]),
        float(translate[1]),
        float(translate[2]),
        float(authored("xformOp:rotateX", 0.0)),
        float(authored("xformOp:rotateY", 0.0)),
        float(authored("xformOp:rotateZ", 0.0)),
    )

def _board_top(stage):
    """Top surface z of the breadboard — components rest on or above it."""
    for prim in stage.Traverse():
        if prim.GetName() == "Breadboard":
            wb = UsdGeom.BBoxCache(Usd.TimeCode.Default(),
                                   [UsdGeom.Tokens.default_]).ComputeWorldBound(prim)
            extent = wb.ComputeAlignedRange()
            # A board prim whose reference does not resolve -- components/ not
            # generated yet, or an asset moved -- carries no geometry, and an
            # empty range reports its max as -FLT_MAX (-3.4e38). Returned as the
            # floor that is *silently no floor at all*: `max(-3.4e38, z)` is
            # always z, so _clamp_z stops clamping and parts sink through the
            # board instead of resting on it. Treat "no measurable board" the
            # same as "no board", which is the Z=0 the layout convention assumes.
            if extent.IsEmpty():
                return 0.0
            return float(extent.GetMax()[2])
    return 0.0

def _clamp_z(stage, z):
    """Keep a component out of the board and inside the scene."""
    return min(Z_MAX_MM, max(_board_top(stage), float(z)))

def _set_xform(prim, x, y, z, rot_x, rot_y, rot_z):
    """Rewrite a component's translation and editable XYZ rotations."""
    xf = UsdGeom.Xformable(prim)
    ops = {op.GetOpName(): op for op in xf.GetOrderedXformOps()}
    if "xformOp:translate" in ops:
        ops["xformOp:translate"].Set(Gf.Vec3d(x, y, z))
        t = ops["xformOp:translate"]
    else:
        t = xf.AddTranslateOp()
        t.Set(Gf.Vec3d(x, y, z))
    order = [t.GetOpName()]
    rotations = (
        ("X", rot_x, xf.AddRotateXOp),
        ("Y", rot_y, xf.AddRotateYOp),
        ("Z", rot_z, xf.AddRotateZOp),
    )
    for axis, value, add_op in rotations:
        op_name = f"xformOp:rotate{axis}"
        if op_name in ops:
            op = ops[op_name]
            op.Set(float(value))
            order.append(op.GetOpName())
        elif value:
            op = add_op()
            op.Set(float(value))
            order.append(op.GetOpName())
    xf.SetXformOpOrder([op for op in xf.GetOrderedXformOps()
                        if op.GetOpName() in order])

# Post holders in the PHxxE family use the matching TRxx post.  Their authored
# placement origin is the insertion-hole centre, so the holder and generated
# post must share the same X/Y gizmo centre.
HOLDER_POST_HOLE_X_MM = 0.0

def _string_attr(prim, name):
    attr = prim.GetAttribute(f"optics:{name}")
    if attr and attr.HasAuthoredValue():
        value = attr.Get()
        return value if isinstance(value, str) else str(value)
    return None

def _set_custom_attr(prim, name, value, value_type=Sdf.ValueTypeNames.String):
    attr = prim.GetAttribute(f"optics:{name}")
    if not attr:
        attr = prim.CreateAttribute(f"optics:{name}", value_type)
    attr.Set(value)

def _matching_post_component(holder_component):
    """Return the library component path for a PHxxE holder's TRxx post."""
    leaf = os.path.basename(holder_component)
    match = re.match(r"^PH(\d+)E(?P<suffix>.*)$", leaf, re.IGNORECASE)
    if not match:
        return None
    candidate = f"Post/TR{match.group(1)}{match.group('suffix')}"
    return candidate if os.path.exists(
        uu.get_component_usda_path(config.LIB_DIR, candidate, "lo")
    ) else None

def _rotate_local_offset(x, y, z, rot_x, rot_y, rot_z):
    """Apply the editor's intrinsic XYZ Euler rotation to a local vector."""
    rx, ry, rz = (math.radians(v) for v in (rot_x, rot_y, rot_z))
    cx, sx = math.cos(rx), math.sin(rx)
    cy, sy = math.cos(ry), math.sin(ry)
    cz, sz = math.cos(rz), math.sin(rz)
    # Rz * Ry * Rx, matching THREE.Euler's default XYZ convention.
    return (
        (cz * cy) * x + (cz * sy * sx - sz * cx) * y
        + (cz * sy * cx + sz * sx) * z,
        (sz * cy) * x + (sz * sy * sx + cz * cx) * y
        + (sz * sy * cx - cz * sx) * z,
        (-sy) * x + (cy * sx) * y + (cy * cx) * z,
    )

def _sync_linked_post(stage, holder):
    """Keep a holder's post on its insertion-hole axis, preserving Z trim."""
    post_name = _string_attr(holder, "pairedPost")
    if not post_name:
        return
    post = stage.GetPrimAtPath(
        f"{stage.GetDefaultPrim().GetPath()}/{post_name}"
    )
    if not post or not post.IsValid():
        return
    hx, hy, hz, rx, ry, rz = _placement_xform_values(holder)
    dx, dy, dz = _rotate_local_offset(
        HOLDER_POST_HOLE_X_MM, 0.0, 0.0, rx, ry, rz
    )
    z_offset_attr = post.GetAttribute("optics:holderZOffset_mm")
    z_offset = float(z_offset_attr.Get()) if (
        z_offset_attr and z_offset_attr.HasAuthoredValue()
    ) else 0.0
    _set_xform(post, hx + dx, hy + dy, _clamp_z(stage, hz + dz + z_offset),
               rx, ry, rz)

def _linked_holder(stage, post):
    holder_name = _string_attr(post, "pairedHolder")
    if not holder_name:
        return None
    holder = stage.GetPrimAtPath(
        f"{stage.GetDefaultPrim().GetPath()}/{holder_name}"
    )
    return holder if holder and holder.IsValid() else None

def _catalog_asset_type(asset):
    """Return the component type authored by a catalogue asset."""
    component_name = uu.get_component_name(asset)
    path = uu.get_component_usda_path(config.LIB_DIR, component_name, "lo")
    asset_stage = Usd.Stage.Open(path) if os.path.exists(path) else None
    if asset_stage is None or not asset_stage.GetDefaultPrim().IsValid():
        return None
    attr = asset_stage.GetDefaultPrim().GetAttribute("optics:type")
    return attr.Get() if attr and attr.HasAuthoredValue() else None

def _replace_component_reference(prim, asset, project_dir):
    """Swap only the library reference, preserving instance-authored state."""
    component_name = uu.get_component_name(asset)
    relative_path = uu.get_relative_component_usda_path(
        config.LIB_DIR, component_name, project_dir
    )
    references = prim.GetReferences()
    references.ClearReferences()
    references.AddReference(relative_path)

def _rebased_reference(ref, from_layer, to_dir):
    """The same reference, expressed relative to `to_dir` instead of its layer."""
    path = ref.assetPath
    if not path or os.path.isabs(path) or "://" in path:
        return ref
    absolute = from_layer.ComputeAbsolutePath(path)
    rebased = os.path.relpath(absolute, to_dir).replace(os.sep, "/")
    if rebased == path:
        return ref
    return Sdf.Reference(rebased, ref.primPath, ref.layerOffset, ref.customData)

def _rebase_asset_paths(layer, prim_path, from_layer):
    """Re-anchor a prim spec copied out of `from_layer` into `layer`.

    Reference paths are authored relative to the file holding them
    (`../../components/...` from `projects/<n>/setup.usda`), so a spec pasted
    from another project's layer has to be recomputed against this one — the
    relative path that resolved there may not resolve here.
    """
    spec = layer.GetPrimAtPath(prim_path)
    if spec is None:
        return
    to_dir = os.path.dirname(layer.realPath or os.path.abspath(layer.identifier))
    for child in spec.nameChildren.values():
        _rebase_asset_paths(layer, child.path, from_layer)
    refs = spec.referenceList
    for field in ("prependedItems", "appendedItems", "explicitItems"):
        items = list(getattr(refs, field))
        if items:
            setattr(refs, field, [_rebased_reference(r, from_layer, to_dir)
                                  for r in items])

def _relink_paired_copies(stage, root, name_map):
    """Point each copy's holder/post link at the copy of its partner.

    A holder names its post in `optics:pairedPost` (and the post names the
    holder back). Copying one without the other would leave the copy driving
    the *original* post — and after a cross-project paste the name wouldn't
    exist here at all — so an unpaired link is dropped instead.
    """
    for copy_name in name_map.values():
        prim = stage.GetPrimAtPath(f"{root}/{copy_name}")
        for key in ("pairedPost", "pairedHolder"):
            partner = _string_attr(prim, key)
            if not partner:
                continue
            if partner in name_map:
                _set_custom_attr(prim, key, name_map[partner])
            else:
                prim.RemoveProperty(f"optics:{key}")
                if key == "pairedHolder":
                    # Only means anything while the post follows a holder.
                    prim.RemoveProperty("optics:holderZOffset_mm")

def _unique_component_name(stage, root, base, taken=()):
    """First free prim name under root: Lens, Lens_2, Lens_3, ...

    `taken` reserves names already handed out in this request but not yet
    authored into the stage.
    """
    name, i = base, 1
    while name in taken or stage.GetPrimAtPath(f"{root}/{name}").IsValid():
        i += 1
        name = f"{base}_{i}"
    return name
