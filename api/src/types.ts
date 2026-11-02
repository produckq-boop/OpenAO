export type AccountRecord = {
    id: string;
    name: string;
    name_sanitized: string | null;
    email: string;
    password: string | null;
    created_at: Date;
    updated_at: Date;
};

export type AuthSessionRecord = {
    token: string;
    account_id: string;
    selected_character_id: string | null;
    created_at: Date;
    expires_at: Date;
};

export type PasswordResetTokenRecord = {
    id: string;
    account_id: string;
    token_hash: string;
    requested_ip: string | null;
    created_at: Date;
    expires_at: Date;
    consumed_at: Date | null;
};

export type PasswordResetRequestRecord = {
    id: string;
    email_hash: string;
    requested_ip: string | null;
    created_at: Date;
};

export type GameTicketRecord = {
    ticket: string;
    account_id: string;
    character_id: string | null;
    auth_token: string;
    mode: string;
    arena_room_id: string | null;
    pvp_template_id: number | null;
    created_at: Date;
    expires_at: Date;
    consumed_at: Date | null;
};

export type ArenaRoomRecord = {
    id: string;
    owner_account_id: string;
    name: string;
    is_public: boolean;
    password_hash: string | null;
    join_token: string;
    map_id: number;
    capacity: number;
    created_at: Date;
    updated_at: Date;
};

export type ArenaRoomMemberRecord = {
    room_id: string;
    account_id: string;
    selected_pvp_template_id: number | null;
    connected: boolean;
    joined_at: Date;
    updated_at: Date;
};

export type UserOnlineStatRecord = {
    sampled_minute: Date;
    total_users: number;
    pve_users: number;
    pvp_users: number;
    fishing_users: number;
    mining_users: number;
    woodcutting_users: number;
    created_at: Date;
};

export type CharacterFaction = "none" | "armada" | "caos";

export type CharacterRecord = {
    id: string;
    account_id: string;
    name: string;
    id_clase: number;
    map_id: number;
    pos_x: number;
    pos_y: number;
    gold: number;
    id_head: number;
    id_last_head: number;
    id_last_body: number;
    id_last_helmet: number;
    id_last_weapon: number;
    id_last_shield: number;
    id_helmet: number;
    id_weapon: number;
    id_shield: number;
    id_body: number;
    id_item_weapon: number;
    id_item_body: number;
    id_item_shield: number;
    id_item_helmet: number;
    id_item_arrow: number;
    spells_acertados: number;
    spells_errados: number;
    hp: number;
    max_hp: number;
    mana: number;
    max_mana: number;
    id_raza: number;
    id_genero: number;
    muerto: boolean;
    min_hit: number;
    max_hit: number;
    attr_fuerza: number;
    attr_agilidad: number;
    attr_inteligencia: number;
    attr_constitucion: number;
    privileges: number;
    count_killed: number;
    count_die: number;
    exp: number;
    exp_next_level: number;
    level: number;
    ip: string | null;
    banned: Date | null;
    ip_banned_until: Date | null;
    dead: boolean;
    criminal: boolean;
    faction: CharacterFaction;
    navegando: boolean;
    npc_matados: number;
    ciudadanos_matados: number;
    criminales_matados: number;
    fianza: number;
    home_map: number;
    home_x: number;
    home_y: number;
    faction_score_armada: number;
    faction_score_caos: number;
    faction_rank_armada: number;
    faction_rank_caos: number;
    faction_rewards_armada: number;
    faction_rewards_caos: number;
    jail_minutes: number;
    jail_reason: string | null;
    connected: boolean;
    clan_id: string | null;
    clan_name?: string | null;
    clan_alignment?: ClanAlignment | null;
    clan_min_join_level?: number | null;
    clan_role?: ClanRole | null;
    deleted_at: Date | null;
    created_at: Date;
    updated_at: Date;
};

export type ClanAlignment = "citizen" | "criminal";

export type ClanRole = "leader" | "co_leader" | "member";

export type ClanRecord = {
    id: string;
    name: string;
    name_normalized: string;
    leader_character_id: string;
    alignment: ClanAlignment;
    min_join_level: number;
    created_at: Date;
    updated_at: Date;
};

export type ClanMemberRecord = {
    clan_id: string;
    character_id: string;
    role: ClanRole;
    joined_at: Date;
    name: string;
    id_clase: number;
    level: number;
    criminal: boolean;
    connected: boolean;
};

export type ClanRequestRecord = {
    id: string;
    clan_id: string;
    character_id: string;
    message: string;
    created_at: Date;
    name: string;
    id_clase: number;
    level: number;
    criminal: boolean;
    connected: boolean;
};

export type CharacterItemRecord = {
    id_pos: number;
    id_item: number;
    cant: number;
    equipped: boolean;
};

export type CharacterBankItemRecord = {
    id_pos: number;
    id_item: number;
    cant: number;
};

export type CharacterSpellRecord = {
    id_pos: number;
    id_spell: number;
};

export type CharacterApiResponse = {
    _id: string;
    idAccount: string;
    name: string;
    idClase: number;
    map: number;
    posX: number;
    posY: number;
    gold: number;
    idHead: number;
    idLastHead: number;
    idLastBody: number;
    idLastHelmet: number;
    idLastWeapon: number;
    idLastShield: number;
    idHelmet: number;
    idWeapon: number;
    idShield: number;
    idBody: number;
    idItemWeapon: number;
    idItemBody: number;
    idItemShield: number;
    idItemHelmet: number;
    idItemArrow: number;
    spellsAcertados: number;
    spellsErrados: number;
    hp: number;
    maxHp: number;
    mana: number;
    maxMana: number;
    idRaza: number;
    idGenero: number;
    muerto: boolean;
    minHit: number;
    maxHit: number;
    attrFuerza: number;
    attrAgilidad: number;
    attrInteligencia: number;
    attrConstitucion: number;
    privileges: number;
    countKilled: number;
    countDie: number;
    exp: number;
    expNextLevel: number;
    level: number;
    ip: string | null;
    banned: Date | null;
    dead: boolean;
    criminal: boolean;
    faction: CharacterFaction;
    navegando: boolean;
    npcMatados: number;
    ciudadanosMatados: number;
    criminalesMatados: number;
    fianza: number;
    homeMap: number;
    homeX: number;
    homeY: number;
    factionScoreArmada: number;
    factionScoreCaos: number;
    factionRankArmada: number;
    factionRankCaos: number;
    factionRewardsArmada: number;
    factionRewardsCaos: number;
    jailMinutes: number;
    jailReason: string | null;
    connected: boolean;
    clanId: string | null;
    clanName: string | null;
    clanAlignment: ClanAlignment | null;
    clanMinJoinLevel: number | null;
    clanRole: ClanRole | null;
    items: Array<{
        idPos: number;
        idItem: number;
        cant: number;
        equipped: boolean;
    }>;
    bankItems: Array<{
        idPos: number;
        idItem: number;
        cant: number;
    }>;
    spells: Array<{
        idPos: number;
        idSpell: number;
    }>;
    createdAt: Date;
    updatedAt: Date;
};

export type AuthCharacterSummary = {
    _id: string;
    name: string;
    level: number;
    map: number;
    className: string;
    raceName: string;
    isAdministrator: boolean;
    criminal: boolean;
    faction: CharacterFaction;
    clanName: string | null;
    id_head: number;
    id_body: number;
    id_weapon: number;
    id_shield: number;
    id_helmet: number;
};

export type CharacterLookupResponse = {
    account: {
        _id: string;
        name: string;
    };
    character: CharacterApiResponse;
};

export type ClanSummaryResponse = {
    id: string;
    name: string;
    alignment: ClanAlignment;
    minJoinLevel: number;
    memberCount: number;
    leaderName: string;
};

export type ClanMemberResponse = {
    characterId: string;
    name: string;
    classId: number;
    level: number;
    criminal: boolean;
    online: boolean | null;
    role: ClanRole;
};

export type ClanRequestResponse = {
    id: string;
    characterId: string;
    name: string;
    classId: number;
    level: number;
    criminal: boolean;
    online: boolean;
    message: string;
    createdAt: Date;
};

export type ClanDetailsResponse = {
    id: string;
    name: string;
    alignment: ClanAlignment;
    minJoinLevel: number;
    leaderCharacterId: string;
    leaderName: string;
    memberCount: number;
    members: ClanMemberResponse[];
    requests: ClanRequestResponse[];
};

export type ClanOverviewResponse = {
    currentClan: ClanDetailsResponse | null;
    clans: ClanSummaryResponse[];
    pendingRequestClanId: string | null;
};

export type AuthResponse = {
    sessionToken: string;
    account: {
        _id: string;
        name: string;
        email: string;
    };
    characters: AuthCharacterSummary[];
};

export type PublicAuthSession = Omit<AuthResponse, "sessionToken">;

export type PublicAuthSessionWithSelection = PublicAuthSession & {
    selectedCharacterId: string | null;
};

export type RuntimeTimingConfig = {
    gameplayTickMs: number;
    walkStepMs: number;
    playerStatusTickMs: number;
    fishingTickMs: number;
    npcThinkMs: number;
    idleCharacterTimeoutMs: number;
    idleCharacterSweepMs: number;
    cleanupClosedCharactersMs: number;
    onlineStatsSnapshotMs: number;
    worldSaveMs: number;
    statusDurations: {
        crowdControlUserMs: number;
        crowdControlNpcMs: number;
        fuerzaAgilidadBuffMs: number;
        invisibilitySpellMs: number;
        npcAttackMs: number;
    };
    actionCooldowns: {
        dialogMs: number;
        clickMs: number;
        doorToggleMs: number;
        meleeMs: number;
        rangeMs: number;
        spellMs: number;
        meleeToSpellMs: number;
        spellToMeleeMs: number;
        useItemMs: number;
        meleeToUseItemMs: number;
        dropItemMs: number;
        equipToggleMs: number;
    };
    visualEffects: {
        invisibilityFadeOutMs: number;
        invisibilityFadeInMs: number;
        invisibilityMinAlpha: number;
        invisibilityMaxAlpha: number;
    };
};

export type RuntimeConfigResponse = {
    timing: RuntimeTimingConfig;
};

export type GameTicketResponse = {
    ticket: string;
    expiresAt: Date;
};

export type ArenaRoomSummary = {
    id: string;
    name: string;
    isPublic: boolean;
    joinToken: string;
    mapId: number;
    capacity: number;
    connectedPlayers: number;
    owner: {
        _id: string;
        name: string;
    };
};

export type ArenaRoomDetails = ArenaRoomSummary & {
    isOwner: boolean;
    member: {
        selectedPvpTemplateId: number | null;
        connected: boolean;
    } | null;
};

export type ArenaGameTicketConsumeResponse = {
    mode: "arena";
    account: {
        _id: string;
        name: string;
        email: string;
    };
    arena: {
        roomId: string;
        roomName: string;
        mapId: number;
        pvpTemplateId: number;
    };
};

export type UserOnlineStatResponse = {
    sampledMinute: Date;
    totalUsers: number;
    pveUsers: number;
    pvpUsers: number;
    fishingUsers: number;
    miningUsers: number;
    woodcuttingUsers: number;
    createdAt: Date;
};

export type UserOnlineStatsResponse = {
    stats: UserOnlineStatResponse[];
};

export type RankingCharacterRecord = {
    id: string;
    name: string;
    level: number;
    exp: number;
    exp_next_level: number;
    count_killed: number;
    id_clase: number;
    id_raza: number;
    criminal: boolean;
    faction: CharacterFaction;
    clan_name: string | null;
    id_head: number;
    id_body: number;
    updated_at: Date;
};

export type RankingCharacterResponse = {
    id: string;
    name: string;
    level: number;
    exp: number;
    expNextLevel: number;
    kills: number;
    idClase: number;
    idRaza: number;
    criminal: boolean;
    faction: CharacterFaction;
    clanName: string | null;
    headId: number;
    bodyId: number;
    updatedAt: Date;
};

export type RankingListResponse = {
    characters: RankingCharacterResponse[];
};

export type ChallengeHistoryParticipant = {
    characterId: string;
    characterName: string;
    teamSide: number;
    level: number;
    className: string;
    raceName: string;
};

export type ChallengeHistoryRecord = {
    id: string;
    match_id: string;
    team_size: number;
    instance_map_id: number;
    winner_side: number;
    finish_reason: string | null;
    team_one_score: number;
    team_two_score: number;
    participants: ChallengeHistoryParticipant[];
    started_at: Date;
    finished_at: Date;
    created_at: Date;
};

export type ChallengeHistoryEntry = {
    id: string;
    matchId: string;
    teamSize: number;
    instanceMapId: number;
    winnerSide: number;
    finishReason: string | null;
    teamOneScore: number;
    teamTwoScore: number;
    participants: ChallengeHistoryParticipant[];
    startedAt: Date;
    finishedAt: Date;
    createdAt: Date;
};

export type UserMapState =
    | "draft"
    | "proposed"
    | "in_review"
    | "published"
    | "rejected"
    | "unpublished";

export type UserMapModerationAction =
    | "propose"
    | "start_review"
    | "approve"
    | "reject"
    | "report"
    | "unpublish"
    | "edit_reset";

export type UserMapCoordinate = {
    x: number;
    y: number;
};

export type UserMapTileEntry = {
    x: number;
    y: number;
    layer: number;
    grhIndex?: number | null;
    blocked?: boolean | null;
};

export type UserMapNpcPlacement = {
    x: number;
    y: number;
    npcId: number;
    name?: string;
    dialogue?: string;
};

export type UserMapObjectPlacement = {
    x: number;
    y: number;
    objectId: number;
    amount?: number;
};

export type UserMapSignEntry = {
    x: number;
    y: number;
    text: string;
};

export type UserMapExitEntry = {
    x: number;
    y: number;
    targetMap?: number;
    targetX?: number;
    targetY?: number;
};

export type UserMapTeleportEntry = {
    fromX: number;
    fromY: number;
    toX: number;
    toY: number;
};

export type UserMapContent = {
    tiles: UserMapTileEntry[];
    blockedTiles: UserMapCoordinate[];
    npcs: UserMapNpcPlacement[];
    objects: UserMapObjectPlacement[];
    signs: UserMapSignEntry[];
    exits: UserMapExitEntry[];
    teleports: UserMapTeleportEntry[];
};

export type UserMapRecord = {
    id: string;
    owner_account_id: string;
    owner_name?: string;
    owner_email?: string;
    name: string;
    description: string;
    width: number;
    height: number;
    spawn_x: number;
    spawn_y: number;
    map_data: UserMapContent;
    npc_count: number;
    object_count: number;
    sign_count: number;
    state: UserMapState;
    reviewer_account_id: string | null;
    rejection_reason: string | null;
    open_report_count: number;
    proposed_at: Date | null;
    reviewed_at: Date | null;
    published_at: Date | null;
    created_at: Date;
    updated_at: Date;
};

export type UserMapSummary = {
    id: string;
    ownerAccountId: string;
    ownerName: string | null;
    name: string;
    description: string;
    width: number;
    height: number;
    spawn: UserMapCoordinate;
    npcCount: number;
    objectCount: number;
    signCount: number;
    state: UserMapState;
    reviewerAccountId: string | null;
    rejectionReason: string | null;
    openReportCount: number;
    proposedAt: string | null;
    reviewedAt: string | null;
    publishedAt: string | null;
    createdAt: string;
    updatedAt: string;
};

export type UserMapDetails = UserMapSummary & {
    mapData: UserMapContent;
};

export type UserMapReportRecord = {
    id: string;
    map_id: string;
    reporter_account_id: string;
    reporter_name?: string;
    reason: string;
    status: "open" | "resolved";
    resolved_by_account_id: string | null;
    resolved_at: Date | null;
    created_at: Date;
};

export type UserMapModerationLogRecord = {
    id: string | number;
    map_id: string;
    actor_account_id: string | null;
    action: UserMapModerationAction;
    from_state: UserMapState;
    to_state: UserMapState;
    reason: string | null;
    created_at: Date;
};

export type MapModeratorRecord = {
    account_id: string;
    account_name?: string;
    account_email?: string;
    granted_by_account_id: string | null;
    note: string | null;
    created_at: Date;
};
