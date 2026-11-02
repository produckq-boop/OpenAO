import type {
    EditorNpc,
    MapTileEntity,
    MapTileOverride,
    UploadedGraphic,
} from "../../../lib/editor/editorApi";
import type { EditorTool } from "../../../lib/editor/editorStore";
import type {
    DraftTileExit,
    DrawMode,
    PlayerCountSummary,
    TileCoord,
    TileRectBounds,
} from "../../../lib/editor/inGameEditorTools";

export type InGameEditorEngineBridge = {
    registerUploadedGraphic: (uploaded: UploadedGraphic) => Promise<void>;
    getPlayerCountSummary: () => PlayerCountSummary;
};

export type InGameEditorSceneConfig = {
    enabled: boolean;
    mapNum: number;
    tool: EditorTool | null;
    drawMode: DrawMode;
    showGrid: boolean;
    showBlocked: boolean;
    overrides: MapTileOverride[];
    entities: MapTileEntity[];
    npcs: EditorNpc[];
    draftExits: DraftTileExit[];
    reloadRevision: number;
    onCursorTileChange?: (tile: TileCoord | null) => void;
    onSelectionPreviewChange?: (bounds: TileRectBounds | null) => void;
    onPlayerCountChange?: (summary: PlayerCountSummary) => void;
    onCommitTiles?: (
        coords: TileCoord[],
        mode: "stroke" | "rect",
    ) => void;
    onBridgeReady?: (bridge: InGameEditorEngineBridge | null) => void;
};
