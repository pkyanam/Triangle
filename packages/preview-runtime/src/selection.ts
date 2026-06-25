import * as THREE from 'three';

/**
 * Lightweight selection highlight (Stage 5.75).
 *
 * OutlinePass would require a post-processing dependency and a second render pass,
 * so Stage 5.75 uses a BoxHelper derived from the selected object's world-space
 * AABB. It is added to a persistent group so it survives hot-reload and dock
 * reparents, and is updated only when a selection exists.
 */

export const DEFAULT_SELECTION_COLOR = 0x4dd2c6;

export class SelectionHighlight {
  private readonly scene: THREE.Scene;
  private readonly helper: THREE.BoxHelper;
  private target: THREE.Object3D | null = null;
  /** The runtime adds this group to its persistent set so it survives hot-reload. */
  readonly persistent: THREE.Group;

  constructor(scene: THREE.Scene, color = DEFAULT_SELECTION_COLOR) {
    this.scene = scene;
    this.helper = new THREE.BoxHelper(new THREE.Object3D(), color);
    this.helper.visible = false;
    this.persistent = new THREE.Group();
    this.persistent.add(this.helper);
    this.scene.add(this.persistent);
  }

  setTarget(obj: THREE.Object3D | null): void {
    this.target = obj;
    this.helper.visible = !!obj;
    if (obj) {
      this.helper.setFromObject(obj);
      this.helper.update();
    }
  }

  getTarget(): THREE.Object3D | null {
    return this.target;
  }

  update(): void {
    if (this.target) {
      this.helper.setFromObject(this.target);
      this.helper.update();
    }
  }

  dispose(): void {
    this.target = null;
    this.helper.visible = false;
    this.helper.dispose();
    this.scene.remove(this.persistent);
  }
}
