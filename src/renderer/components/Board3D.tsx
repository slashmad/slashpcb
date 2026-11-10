// 3D view of the board from kicad-cli's GLB export (tracks, pads, zones, silkscreen, mask, parts).
import { useEffect, useRef, useState } from "react";
import * as THREE from "three";
import { GLTFLoader } from "three/examples/jsm/loaders/GLTFLoader.js";
import { OrbitControls } from "three/examples/jsm/controls/OrbitControls.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";
import { api } from "../api";
import { useT } from "../i18n";

export function Board3D({ glb, active, running, dark }: { glb: string | null; active: boolean; running: boolean; dark: boolean }) {
  const t = useT();
  const mount = useRef<HTMLDivElement>(null);
  const three = useRef<{ renderer: THREE.WebGLRenderer; scene: THREE.Scene; camera: THREE.PerspectiveCamera; controls: OrbitControls; model: THREE.Object3D | null; render(): void } | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  useEffect(() => { if (active && !glb) api.design.want3d(); }, [active, glb]);

  useEffect(() => {
    const el = mount.current;
    if (!el) return;
    const renderer = new THREE.WebGLRenderer({ antialias: true });
    renderer.setPixelRatio(window.devicePixelRatio || 1);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    el.appendChild(renderer.domElement);
    const scene = new THREE.Scene();
    const pmrem = new THREE.PMREMGenerator(renderer);
    scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    const camera = new THREE.PerspectiveCamera(35, 1, 0.1, 10000);
    camera.up.set(0, 0, 1);
    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = false;
    controls.mouseButtons = { LEFT: THREE.MOUSE.ROTATE, MIDDLE: THREE.MOUSE.PAN, RIGHT: THREE.MOUSE.PAN };
    controls.zoomToCursor = true;
    const render = () => renderer.render(scene, camera);
    controls.addEventListener("change", render);
    scene.add(new THREE.HemisphereLight(0xffffff, 0x444455, 1.2));
    const key = new THREE.DirectionalLight(0xffffff, 1.4);
    key.position.set(-1, -2, 3);
    scene.add(key);
    const ro = new ResizeObserver(() => {
      const w = el.clientWidth, h = el.clientHeight;
      if (!w || !h) return;
      renderer.setSize(w, h);
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      render();
    });
    ro.observe(el);
    three.current = { renderer, scene, camera, controls, model: null, render };
    return () => { ro.disconnect(); controls.dispose(); renderer.dispose(); el.removeChild(renderer.domElement); three.current = null; };
  }, []);

  useEffect(() => {
    const th = three.current;
    if (th) { th.scene.background = new THREE.Color(dark ? 0x101318 : 0xe9ecf0); th.render(); }
  }, [dark]);

  useEffect(() => {
    const th = three.current;
    if (!th || !glb) return;
    let live = true;
    setLoading(true);
    setErr(null);
    api.design.file(glb).then((bytes) => {
      if (!live) return;
      const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
      new GLTFLoader().parse(buf, "", (gltf) => {
        if (!live) return;
        const first = !th.model;
        if (th.model) th.scene.remove(th.model);
        const m = gltf.scene;
        // KiCad exports Y-up metres; show Z-up millimetres like the board.
        m.rotation.x = Math.PI / 2;
        m.scale.setScalar(1000);
        th.scene.add(m);
        th.model = m;
        if (first) {
          const box = new THREE.Box3().setFromObject(m);
          const c = box.getCenter(new THREE.Vector3()), s = box.getSize(new THREE.Vector3()).length();
          th.controls.target.copy(c);
          th.camera.position.set(c.x - s * 0.5, c.y - s * 0.9, c.z + s * 0.8);
          th.camera.near = s / 1000; th.camera.far = s * 20; th.camera.updateProjectionMatrix();
          th.controls.update();
        }
        th.render();
        setLoading(false);
      }, (e) => { if (live) { setErr(String((e as any)?.message ?? e)); setLoading(false); } });
    }).catch((e) => { if (live) { setErr(String(e?.message ?? e)); setLoading(false); } });
    return () => { live = false; };
  }, [glb]);

  const viewFrom = (dir: "top" | "bottom" | "iso") => {
    const th = three.current;
    if (!th?.model) return;
    const box = new THREE.Box3().setFromObject(th.model);
    const c = box.getCenter(new THREE.Vector3()), s = box.getSize(new THREE.Vector3()).length();
    th.controls.target.copy(c);
    if (dir === "top") th.camera.position.set(c.x, c.y - 0.001, c.z + s * 1.3);
    else if (dir === "bottom") th.camera.position.set(c.x, c.y + 0.001, c.z - s * 1.3);
    else th.camera.position.set(c.x - s * 0.5, c.y - s * 0.9, c.z + s * 0.8);
    th.controls.update();
    th.render();
  };

  return (
    <div className="board3d">
      <div ref={mount} className="three-mount" />
      {(!glb || loading) && <div className="empty-view muted overlay">{running || loading ? <><span className="spinner" /> {t("3d.exporting")}</> : t("3d.none")}</div>}
      {err && <div className="err-msg overlay">{err}</div>}
      <div className="view-tools">
        <button onClick={() => viewFrom("top")}>{t("board.top")}</button>
        <button onClick={() => viewFrom("bottom")}>{t("board.bottom")}</button>
        <button onClick={() => viewFrom("iso")}>{t("3d.iso")}</button>
        <button onClick={() => api.design.want3d(true)} title={t("3d.refreshTitle")}>⟳</button>
      </div>
    </div>
  );
}
