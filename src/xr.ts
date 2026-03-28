import {
    Color,
    Entity,
    Quat,
    StandardMaterial,
    Vec3,
    type CameraComponent
} from 'playcanvas';
import { XrControllers } from 'playcanvas/scripts/esm/xr-controllers.mjs';
import { XrNavigation } from 'playcanvas/scripts/esm/xr-navigation.mjs';

import { Global } from './types';

// On-screen debug overlay
const debugLines: string[] = [];
let debugEl: HTMLDivElement | null = null;

const dbg = (msg: string) => {
    console.log(msg);
    debugLines.push(`${new Date().toLocaleTimeString()} ${msg}`);
    if (debugLines.length > 20) debugLines.shift();
    if (!debugEl) {
        debugEl = document.createElement('div');
        debugEl.style.cssText = 'position:fixed;top:0;left:0;right:0;z-index:99999;background:rgba(0,0,0,0.7);color:#0f0;font:12px monospace;padding:8px;max-height:40vh;overflow-y:auto;pointer-events:none;';
        const overlay = document.getElementById('ar-overlay');
        (overlay || document.body).appendChild(debugEl);
    }
    debugEl.textContent = debugLines.join('\n');
};

const initXr = (global: Global) => {
    const { app, events, state, camera } = global;

    state.hasAR = app.xr.isAvailable('immersive-ar');
    state.hasVR = app.xr.isAvailable('immersive-vr');
    dbg(`[XR init] hasAR=${state.hasAR}, hasVR=${state.hasVR}`);

    app.xr.on('available:immersive-ar', (available) => {
        dbg(`[XR] immersive-ar available: ${available}`);
        state.hasAR = available;
    });
    app.xr.on('available:immersive-vr', (available) => {
        state.hasVR = available;
    });

    const parent = camera.parent as Entity;
    const clearColor = new Color();
    const parentPosition = new Vec3();
    const parentRotation = new Quat();
    const cameraPosition = new Vec3();
    const cameraRotation = new Quat();
    const angles = new Vec3();

    parent.addComponent('script');
    const xrCtrl = parent.script.create(XrControllers);
    const xrNav = parent.script.create(XrNavigation);

    let arPlaced = false;
    let gsplatEntity: Entity | null = null;
    let reticle: Entity | null = null;
    let reticleHitCount = 0;

    const buildReticle = () => {
        const entity = new Entity('ar-reticle');
        const mat = new StandardMaterial();
        mat.diffuse = new Color(1, 1, 1);
        mat.emissive = new Color(0.5, 0.5, 0.5);
        mat.opacity = 0.7;
        mat.blendType = 2;
        mat.depthWrite = false;
        mat.update();
        entity.addComponent('render', { type: 'plane', material: mat });
        entity.setLocalScale(0.15, 0.15, 0.15);
        entity.enabled = false;
        app.root.addChild(entity);
        return entity;
    };

    // ---- XR START ----
    app.xr.on('start', () => {
        app.autoRender = true;
        dbg(`[XR] started, type=${app.xr.type}`);

        parentPosition.copy(parent.getPosition());
        parentRotation.copy(parent.getRotation());
        cameraPosition.copy(camera.getPosition());
        cameraRotation.copy(camera.getRotation());
        cameraRotation.getEulerAngles(angles);

        if (app.xr.type === 'immersive-ar') {
            // Reset parent for clean AR tracking
            parent.setPosition(0, 0, 0);
            parent.setEulerAngles(0, 0, 0);

            if (xrCtrl) xrCtrl.enabled = false;
            if (xrNav) {
                xrNav.enabled = false;
                // Kill ALL XR input listeners — tryTeleport on selectend moves the camera parent
                for (const [src, handlers] of xrNav.inputHandlers) {
                    src.off('selectstart', handlers.handleSelectStart);
                    src.off('selectend', handlers.handleSelectEnd);
                }
                xrNav.inputHandlers.clear();
                xrNav.inputSources.clear();
                xrNav.activePointers.clear();
                // Remove the 'add' listener so new XR input sources don't get handlers
                app.xr.input.off('add');
                dbg('[AR] xrNav input listeners removed');
            }

            clearColor.copy(camera.camera.clearColor);
            camera.camera.clearColor = new Color(0, 0, 0, 0);

            // Hide splat, wait for tap
            gsplatEntity = app.root.findByName('gsplat') as Entity | null;
            dbg(`[AR] gsplat found: ${!!gsplatEntity}`);
            if (gsplatEntity) gsplatEntity.enabled = false;
            arPlaced = false;
            reticleHitCount = 0;

            if (!reticle) reticle = buildReticle();
            reticle.enabled = false;

            // Start hit tests
            dbg(`[AR] hitTest supported=${app.xr.hitTest.supported}`);

            // Viewer hit test — reticle on surface
            app.xr.hitTest.start({
                spaceType: 'viewer',
                callback: (err: any, hitTestSource: any) => {
                    if (err) {
                        dbg(`[AR] viewer hitTest ERR: ${err.message}`);
                        return;
                    }
                    dbg('[AR] viewer hitTest started');
                    hitTestSource.on('result', (position: Vec3, rotation: Quat) => {
                        reticleHitCount++;
                        if (reticleHitCount <= 5 || reticleHitCount % 50 === 0) {
                            dbg(`[AR] reticle #${reticleHitCount}: ${position.x.toFixed(2)},${position.y.toFixed(2)},${position.z.toFixed(2)}`);
                        }
                        if (reticle) {
                            reticle.enabled = true;
                            reticle.setPosition(position);
                            reticle.setRotation(rotation);
                        }
                    });
                }
            });

            // DOM touch — change reticle color to red on tap
            const reticleMat = reticle.render!.meshInstances[0].material as StandardMaterial;
            let tapped = false;
            const onTouch = (e: TouchEvent) => {
                e.stopPropagation();
                if ((e.target as HTMLElement).tagName === 'BUTTON') return;
                tapped = !tapped;
                if (tapped) {
                    reticleMat.diffuse = new Color(1, 0, 0);
                    reticleMat.emissive = new Color(1, 0, 0);
                } else {
                    reticleMat.diffuse = new Color(1, 1, 1);
                    reticleMat.emissive = new Color(0.5, 0.5, 0.5);
                }
                reticleMat.update();
                dbg(`[AR] TAP → reticle color ${tapped ? 'RED' : 'WHITE'}`);
            };
            overlayEl.style.pointerEvents = 'auto';
            overlayEl.addEventListener('touchstart', onTouch);
            app.xr.once('end', () => {
                overlayEl.removeEventListener('touchstart', onTouch);
                overlayEl.style.pointerEvents = 'none';
            });

            // Periodic status log
            const statusInterval = setInterval(() => {
                const cp = camera.getPosition();
                const re = reticle ? reticle.enabled : 'null';
                dbg(`[AR] cam=${cp.x.toFixed(1)},${cp.y.toFixed(1)},${cp.z.toFixed(1)} reticle=${re} hits=${reticleHitCount}`);
            }, 3000);
            app.xr.once('end', () => clearInterval(statusInterval));

        } else {
            parent.setPosition(cameraPosition.x, 0, cameraPosition.z);
            parent.setEulerAngles(0, angles.y, 0);
        }
    });

    // ---- XR END ----
    app.xr.on('end', () => {
        dbg(`[XR] END fired! type=${app.xr.type}`);
        app.autoRender = false;
        if (xrCtrl) xrCtrl.enabled = true;
        if (xrNav) xrNav.enabled = true;
        arPlaced = false;

        if (gsplatEntity) {
            gsplatEntity.enabled = true;
            gsplatEntity.setLocalScale(1, 1, 1);
            gsplatEntity.setPosition(0, 0, 0);
            gsplatEntity.setLocalEulerAngles(0, 0, 180);
        }
        if (reticle) reticle.enabled = false;

        parent.setPosition(parentPosition);
        parent.setRotation(parentRotation);
        camera.setPosition(cameraPosition);
        camera.setRotation(cameraRotation);
        if (app.xr.type === 'immersive-ar') {
            camera.camera.clearColor = clearColor;
        }
        requestAnimationFrame(() => {
            document.body.prepend(app.graphicsDevice.canvas);
            app.renderNextFrame = true;
        });
    });

    // DOM overlay for AR
    const overlayEl = document.createElement('div');
    overlayEl.id = 'ar-overlay';
    overlayEl.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;z-index:99999;pointer-events:none;';

    const exitBtn = document.createElement('button');
    exitBtn.textContent = 'EXIT AR';
    exitBtn.style.cssText = 'position:fixed;bottom:40px;left:50%;transform:translateX(-50%);padding:16px 32px;font-size:20px;font-weight:bold;background:#ff4444;color:#fff;border:none;border-radius:12px;pointer-events:auto;cursor:pointer;display:none;';
    exitBtn.addEventListener('click', () => {
        dbg('[AR] exit clicked');
        app.xr.end();
    });
    overlayEl.appendChild(exitBtn);

    app.xr.on('start', () => {
        if (app.xr.type === 'immersive-ar') exitBtn.style.display = 'block';
    });
    app.xr.on('end', () => { exitBtn.style.display = 'none'; });
    document.body.appendChild(overlayEl);

    if (debugEl) {
        overlayEl.appendChild(debugEl);
        debugEl.style.pointerEvents = 'none';
    }

    const start = (type: string) => {
        camera.camera.nearClip = 0.01;
        camera.camera.farClip = 1000;
        if (type === 'immersive-ar') {
            app.xr.domOverlay.root = overlayEl;
            dbg('[AR] domOverlay set, starting...');
        }
        app.xr.start(app.root.findComponent('camera') as CameraComponent, type, 'local-floor');
    };

    events.on('startAR', () => start('immersive-ar'));
    events.on('startVR', () => start('immersive-vr'));

    // Test AR button
    const testBtn = document.createElement('button');
    testBtn.textContent = 'START AR';
    testBtn.style.cssText = 'position:fixed;bottom:80px;left:50%;transform:translateX(-50%);z-index:99999;padding:20px 40px;font-size:24px;font-weight:bold;background:#7B72FF;color:#fff;border:none;border-radius:12px;cursor:pointer;';
    testBtn.addEventListener('click', () => {
        dbg('[AR] button clicked');
        events.fire('startAR');
    });
    document.body.appendChild(testBtn);

    events.on('inputEvent', (event) => {
        if (event === 'cancel' && app.xr.active) {
            app.xr.end();
        }
    });
};

export { initXr };
