import React, { useState, useEffect, useCallback } from 'react';
import { Box, Text, useInput } from 'ink';
import {
  type CircuitContext,
  QueryContext,
  sampleContractAddress,
  createConstructorContext,
  CostModel,
} from '@midnight-ntwrk/compact-runtime';
import { Contract, ledger, type Witnesses } from '../go-fish/contract/index.js';
import { createPlayerWitnesses, type PrivateState } from './witnesses.js';
import { log, logError } from './logger.js';

// ============================================
// TYPES
// ============================================

// Contract GamePhase enum values (from GoFish.compact)
const ContractGamePhase = {
  Setup: 0,
  TurnStart: 1,
  WaitForResponse: 2,
  WaitForTransfer: 3,
  WaitForDraw: 4,
  WaitForDrawCheck: 5,
  GameOver: 6,
} as const;

type ContractGamePhaseValue = typeof ContractGamePhase[keyof typeof ContractGamePhase];

// UI-specific phases for initialization flow
type UIPhase = 'initializing' | 'shuffling' | 'dealing' | 'ready';

type GameState = {
  uiPhase: UIPhase;
  contractPhase: ContractGamePhaseValue;
  currentTurn: 1 | 2;
  player1Hand: bigint[];
  player2Hand: bigint[];
  player1Score: number;
  player2Score: number;
  message: string;
  loading: boolean;
  lastRequestedRank: number | null; // Track for afterGoFish check
};

type InputMode = 'none' | 'selectRank' | 'confirmAsk';

// Helper to convert contract phase to readable string
function getPhaseString(phase: ContractGamePhaseValue): string {
  switch (phase) {
    case ContractGamePhase.Setup: return 'Setup';
    case ContractGamePhase.TurnStart: return 'Turn Start';
    case ContractGamePhase.WaitForResponse: return 'Waiting for Response';
    case ContractGamePhase.WaitForTransfer: return 'Transferring Cards';
    case ContractGamePhase.WaitForDraw: return 'Go Fish - Draw';
    case ContractGamePhase.WaitForDrawCheck: return 'Checking Draw';
    case ContractGamePhase.GameOver: return 'Game Over';
    default: return 'Unknown';
  }
}

// ============================================
// CARD HELPERS
// ============================================

const RANK_NAMES = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];
const SUIT_NAMES = ['♠', '♥', '♦', '♣'];

function getCardRank(cardValue: bigint): number {
  return Number(cardValue) % 13;
}

function getCardSuit(cardValue: bigint): number {
  return Math.floor(Number(cardValue) / 13);
}

function formatCard(cardValue: bigint): string {
  const rank = getCardRank(cardValue);
  const suit = getCardSuit(cardValue);
  return `${RANK_NAMES[rank]}${SUIT_NAMES[suit]}`;
}

function getRankName(rank: number): string {
  return RANK_NAMES[rank] || '?';
}

function groupCardsByRank(hand: bigint[]): Map<number, bigint[]> {
  const grouped = new Map<number, bigint[]>();
  for (const card of hand) {
    const rank = getCardRank(card);
    if (!grouped.has(rank)) grouped.set(rank, []);
    grouped.get(rank)!.push(card);
  }
  return grouped;
}

// ============================================
// PLAYER CLASS
// ============================================

class Player {
  readonly playerId: 1 | 2;
  readonly contract: Contract<PrivateState, Witnesses<PrivateState>>;

  constructor(playerId: 1 | 2) {
    this.playerId = playerId;
    log(`Creating Player ${playerId} contract...`);
    const playerWitnesses = createPlayerWitnesses(playerId);
    this.contract = new Contract<PrivateState, Witnesses<PrivateState>>(
      playerWitnesses,
    );
    log(`Player ${playerId} contract created`);
  }

  get circuits() {
    return this.contract.circuits;
  }

  get impureCircuits() {
    return this.contract.impureCircuits;
  }
}

// ============================================
// SIMULATOR CLASS
// ============================================

class GoFishGame {
  readonly player1: Player;
  readonly player2: Player;
  circuitContext: CircuitContext<PrivateState>;

  constructor() {
    log('GoFishGame constructor started');
    
    try {
      log('Creating Player instances...');
      this.player1 = new Player(1);
      this.player2 = new Player(2);
      log('Players created');
      
      // Use player1's contract for initialization (they're equivalent for initialState)
      log('Calling initialState...');
      const initialStateResult = this.player1.contract.initialState(createConstructorContext({}, '0'.repeat(64)));
      log('initialState returned', {
        hasPrivateState: !!initialStateResult.currentPrivateState,
        hasContractState: !!initialStateResult.currentContractState,
        hasZswapLocalState: !!initialStateResult.currentZswapLocalState,
        contractStateKeys: initialStateResult.currentContractState ? Object.keys(initialStateResult.currentContractState) : [],
      });
      
      const { currentPrivateState, currentContractState, currentZswapLocalState } = initialStateResult;
      
      log('Contract state data check', {
        hasData: !!currentContractState?.data,
        dataType: typeof currentContractState?.data,
        dataKeys: currentContractState?.data ? Object.keys(currentContractState.data) : [],
      });
      
      this.circuitContext = {
        currentPrivateState,
        currentZswapLocalState,
        currentQueryContext: new QueryContext(
          currentContractState.data,
          sampleContractAddress(),
        ),
        costModel: CostModel.initialCostModel(),
      };
      
      log('Circuit context created successfully');
      
      // Try to read ledger immediately to test
      try {
        log('Testing ledger access...');
        const state = this.circuitContext.currentQueryContext.state;
        log('Query context state', {
          hasState: !!state,
          stateType: typeof state,
          stateKeys: state ? Object.keys(state) : [],
        });
        
        const l = ledger(state);
        log('Ledger access successful', {
          ledgerKeys: l ? Object.keys(l) : [],
        });
      } catch (ledgerError: any) {
        logError('Ledger test failed', ledgerError);
      }
      
    } catch (error: any) {
      logError('GoFishGame constructor failed', error);
      throw error;
    }
    
    log('GoFishGame constructor completed');
  }

  getPlayer(playerId: 1 | 2): Player {
    return playerId === 1 ? this.player1 : this.player2;
  }

  getLedger() {
    try {
      const state = this.circuitContext.currentQueryContext.state;
      log('getLedger called', { hasState: !!state });
      return ledger(state);
    } catch (error: any) {
      logError('getLedger failed', error);
      throw error;
    }
  }
}

// ============================================
// MAIN APP COMPONENT
// ============================================

export default function App() {
  const [game, setGame] = useState<GoFishGame | null>(null);
  const [gameState, setGameState] = useState<GameState>({
    uiPhase: 'initializing',
    contractPhase: ContractGamePhase.Setup,
    currentTurn: 1,
    player1Hand: [],
    player2Hand: [],
    player1Score: 0,
    player2Score: 0,
    message: '🎮 Welcome to GO FISH!',
    loading: false,
    lastRequestedRank: null,
  });
  const [inputMode, setInputMode] = useState<InputMode>('none');
  const [availableRanks, setAvailableRanks] = useState<number[]>([]);
  const [rankSelectionIndex, setRankSelectionIndex] = useState<number>(0);
  const [selectedRank, setSelectedRank] = useState<number | null>(null);
  const [contractCallLog, setContractCallLog] = useState<string[]>([]);

  // Helper to log contract calls (keeps last 10)
  const logContractCall = useCallback((call: string) => {
    setContractCallLog(prev => {
      const newLog = [...prev, call];
      return newLog.slice(-10); // Keep only last 10
    });
  }, []);

  // ============================================
  // CONTRACT INTERACTION FUNCTIONS
  // ============================================

  const applyMask = useCallback(async (g: GoFishGame, playerId: number) => {
    logContractCall(`[P${playerId}] applyMask()`);
    const player = g.getPlayer(playerId as 1 | 2);
    const r = player.impureCircuits.applyMask(g.circuitContext, BigInt(playerId));
    g.circuitContext = r.context;
  }, [logContractCall]);

  // Get current game phase from contract
  const getContractPhase = useCallback((g: GoFishGame): ContractGamePhaseValue => {
    const r = g.player1.circuits.getGamePhase(g.circuitContext);
    g.circuitContext = r.context;
    return r.result as ContractGamePhaseValue;
  }, []);

  // Get current turn from contract
  const getContractTurn = useCallback((g: GoFishGame): 1 | 2 => {
    const r = g.player1.circuits.getCurrentTurn(g.circuitContext);
    g.circuitContext = r.context;
    return Number(r.result) as 1 | 2;
  }, []);

  // Get scores from contract
  const getContractScores = useCallback((g: GoFishGame): [number, number] => {
    const r = g.player1.circuits.getScores(g.circuitContext);
    g.circuitContext = r.context;
    return [Number(r.result[0]), Number(r.result[1])];
  }, []);


  // Deal all cards and start the game (calls dealCards which handles dealing + startGame internally)
  const callDealCards = useCallback((g: GoFishGame) => {
    log('Calling contract dealCards()');
    logContractCall('[System] dealCards()');
    const r1 = g.player1.impureCircuits.dealCards(g.circuitContext, BigInt(1));
    g.circuitContext = r1.context;

    const r2 = g.player2.impureCircuits.dealCards(g.circuitContext, BigInt(2));
    g.circuitContext = r2.context;

    log('dealCards completed');
  }, [logContractCall]);

  // Query which cards a player has by checking each card index (0-51)
  const queryPlayerHand = useCallback((g: GoFishGame, playerId: number): bigint[] => {
    log(`Querying hand for player ${playerId}`);
    const hand: bigint[] = [];
    const circuits = playerId === 1 ? g.player1.circuits : g.player2.circuits;
    const pid = BigInt(playerId);
    
    for (let cardIndex = 0; cardIndex < 52; cardIndex++) {
      const r = circuits.doesPlayerHaveSpecificCard(g.circuitContext, pid, BigInt(cardIndex));
      g.circuitContext = r.context;
      if (r.result) {
        hand.push(BigInt(cardIndex));
      }
    }
    
    log(`Player ${playerId} hand discovered: ${hand.length} cards`);
    return hand;
  }, []);

  // Draw card during "Go Fish" - uses the contract's goFish circuit which enforces phase
  const drawCardGoFish = useCallback(async (g: GoFishGame, playerId: number): Promise<bigint> => {
    log(`Player ${playerId} going fishing (contract goFish circuit)`);
    logContractCall(`[P${playerId}] goFish()`);
    const player = g.getPlayer(playerId as 1 | 2);
    const opponent = playerId === 1 ? g.player2 : g.player1;
    // Use the contract's goFish impure circuit which enforces phase validation
    const r1 = opponent.impureCircuits.goFish(g.circuitContext, BigInt(playerId));
    g.circuitContext = r1.context;
    const encryptedPoint = r1.result;

    // Decrypt with player's key (pure circuit - no logging)
    const r2 = player.circuits.partial_decryption(g.circuitContext, encryptedPoint, BigInt(playerId));
    g.circuitContext = r2.context;
    const decryptedPoint = r2.result;

    // Get card value (pure circuit - no logging)
    const r3 = player.circuits.get_card_from_point(g.circuitContext, decryptedPoint);
    g.circuitContext = r3.context;
    return r3.result;
  }, [logContractCall]);

  // Call afterGoFish to notify contract whether drawn card matched
  // Now requires playerId as first parameter for security validation
  const callAfterGoFish = useCallback((g: GoFishGame, playerId: number, drewRequestedCard: boolean) => {
    log(`Calling afterGoFish with playerId=${playerId}, drewRequestedCard=${drewRequestedCard}`);
    logContractCall(`[P${playerId}] afterGoFish(matched=${drewRequestedCard})`);
    const player = g.getPlayer(playerId as 1 | 2);
    const r = player.impureCircuits.afterGoFish(g.circuitContext, BigInt(playerId), drewRequestedCard);
    g.circuitContext = r.context;
  }, [logContractCall]);

  // Call askForCard + respondToAsk - two-step flow for asking for cards
  // Step 1: askForCard - called by the asking player (validates rules 1-4)
  // Step 2: respondToAsk - called by the opponent (checks hand, transfers cards or Go Fish)
  // Returns [opponentHadCard: boolean, cardsTransferred: number]
  // - If opponent has cards: transfers them and returns [true, count]
  // - If "Go Fish": transitions to draw phase and returns [false, 0]
  const callAskForCardAndProcess = useCallback((g: GoFishGame, playerId: number, rank: number): { opponentHadCard: boolean; cardsTransferred: number } => {
    log(`Calling askForCard + respondToAsk: player ${playerId} asking for rank ${rank}`);
    
    // Step 1: Asking player calls askForCard
    logContractCall(`[P${playerId}] askForCard(${RANK_NAMES[rank]})`);
    const askingPlayer = g.getPlayer(playerId as 1 | 2);
    const r1 = askingPlayer.impureCircuits.askForCard(g.circuitContext, BigInt(playerId), BigInt(rank));
    g.circuitContext = r1.context;
    
    // Step 2: Opponent calls respondToAsk
    const opponentId = playerId === 1 ? 2 : 1;
    logContractCall(`[P${opponentId}] respondToAsk()`);
    const opponent = g.getPlayer(opponentId as 1 | 2);
    const r2 = opponent.impureCircuits.respondToAsk(g.circuitContext, BigInt(opponentId));
    g.circuitContext = r2.context;
    
    const [opponentHadCard, cardsTransferred] = r2.result as [boolean, bigint];
    log(`respondToAsk result: opponentHadCard=${opponentHadCard}, cardsTransferred=${cardsTransferred}`);
    return { opponentHadCard, cardsTransferred: Number(cardsTransferred) };
  }, [logContractCall]);

  // Call switchTurn to switch to other player
  // Now requires playerId as parameter for security validation (only current player can switch)
  const callSwitchTurn = useCallback((g: GoFishGame, playerId: number) => {
    log(`Calling switchTurn with playerId=${playerId}`);
    logContractCall(`[P${playerId}] switchTurn()`);
    const player = g.getPlayer(playerId as 1 | 2);
    const r = player.impureCircuits.switchTurn(g.circuitContext, BigInt(playerId));
    g.circuitContext = r.context;
  }, [logContractCall]);

  // Check and score a book using contract
  const checkAndScoreBookContract = useCallback((g: GoFishGame, playerId: number, rank: number): boolean => {
    log(`Checking for book: player ${playerId}, rank ${rank}`);
    logContractCall(`[P${playerId}] checkAndScoreBook(${RANK_NAMES[rank]})`);
    const player = g.getPlayer(playerId as 1 | 2);
    const r = player.impureCircuits.checkAndScoreBook(g.circuitContext, BigInt(playerId), BigInt(rank));
    g.circuitContext = r.context;
    return r.result;
  }, [logContractCall]);

  // Check if game should end
  const checkAndEndGameContract = useCallback((g: GoFishGame): boolean => {
    // logContractCall('checkAndEndGame()');
    const r = g.player1.circuits.checkAndEndGame(g.circuitContext);
    // const r = g.impureCircuits.checkAndEndGame(g.circuitContext);
    // g.circuitContext = r.context;
    return r.result;
  }, [logContractCall]);

  const getDeckRemaining = useCallback((g: GoFishGame): number => {
    try {
      log('getDeckRemaining called');
      const circuits = g.player1.circuits;
      const sizeResult = circuits.get_deck_size(g.circuitContext);
      log('get_deck_size result', { hasResult: !!sizeResult, result: String(sizeResult?.result) });
      const size = sizeResult.result;
      
      const indexResult = circuits.get_top_card_index(g.circuitContext);
      log('get_top_card_index result', { hasResult: !!indexResult, result: String(indexResult?.result) });
      const index = indexResult.result;
      
      const remaining = Number(size) - Number(index);
      log('Deck remaining', { size: Number(size), index: Number(index), remaining });
      return remaining;
    } catch (error: any) {
      logError('getDeckRemaining failed', error);
      throw error;
    }
  }, []);

  const isDeckEmpty = useCallback((g: GoFishGame): boolean => {
    return getDeckRemaining(g) <= 0;
  }, [getDeckRemaining]);

  // ============================================
  // GAME LOGIC
  // ============================================

  // Check for books using contract and update scores
  const checkForBooksWithContract = useCallback((g: GoFishGame, playerId: number, hand: bigint[]): { booksScored: number[], updatedHand: bigint[] } => {
    const grouped = groupCardsByRank(hand);
    const booksScored: number[] = [];
    let updatedHand = [...hand];

    for (const [rank, cards] of grouped.entries()) {
      if (cards.length === 4) {
        // Use contract to score the book (validates and updates contract state)
        const scored = checkAndScoreBookContract(g, playerId, rank);
        if (scored) {
          booksScored.push(rank);
          // Remove the 4 cards from hand
          updatedHand = updatedHand.filter(c => getCardRank(c) !== rank);
        }
      }
    }

    return { booksScored, updatedHand };
  }, [checkAndScoreBookContract]);

  // Sync game state from contract
  const syncFromContract = useCallback((g: GoFishGame): { phase: ContractGamePhaseValue, turn: 1 | 2, scores: [number, number] } => {
    const phase = getContractPhase(g);
    const turn = getContractTurn(g);
    const scores = getContractScores(g);
    return { phase, turn, scores };
  }, [getContractPhase, getContractTurn, getContractScores]);

  // ============================================
  // INITIALIZATION
  // ============================================

  useEffect(() => {
    const initGame = async () => {
      log('initGame started');
      
      let g: GoFishGame;
      try {
        log('Creating GoFishGame...');
        g = new GoFishGame();
        log('GoFishGame created successfully');
        setGame(g);
      } catch (error: any) {
        logError('Failed to create GoFishGame', error);
        setGameState(prev => ({ ...prev, message: `❌ Failed to initialize: ${error.message}` }));
        return;
      }

      try {
        // Verify contract is in Setup phase
        const initialPhase = getContractPhase(g);
        log('Initial contract phase', { phase: initialPhase });
        if (initialPhase !== ContractGamePhase.Setup) {
          throw new Error(`Contract not in Setup phase, got: ${initialPhase}`);
        }

        // Phase 1: Shuffling (both players apply masks)
        log('Starting Phase 1: Shuffling');
        setGameState(prev => ({ ...prev, uiPhase: 'shuffling', message: '🔀 Player 1 shuffling deck...' }));
        
        log('Applying mask for player 1...');
        await applyMask(g, 1);
        log('Player 1 mask applied');
        
        setGameState(prev => ({ ...prev, message: '🔀 Player 2 shuffling deck...' }));
        
        log('Applying mask for player 2...');
        await applyMask(g, 2);
        log('Player 2 mask applied');

        // Phase 2: Dealing (7 cards each) + Start game
        log('Starting Phase 2: Dealing');
        setGameState(prev => ({ ...prev, uiPhase: 'dealing', message: '🃏 Dealing cards...' }));
        
        // Call dealCards which deals 7 cards to each player and starts the game
        callDealCards(g);
        
        // Verify contract transitioned correctly
        const phaseAfterDeal = getContractPhase(g);
        log('Contract phase after dealCards', { phase: phaseAfterDeal });
        if (phaseAfterDeal !== ContractGamePhase.TurnStart) {
          throw new Error(`dealCards did not transition to TurnStart, got: ${phaseAfterDeal}`);
        }
        
        // Query hands from contract to discover what cards each player has
        log('Querying player hands...');
        const p1Hand = queryPlayerHand(g, 1);
        const p2Hand = queryPlayerHand(g, 2);

        log('Dealing complete', { p1Hand: p1Hand.map(String), p2Hand: p2Hand.map(String) });

        // Check for initial books using contract validation
        const p1BookResult = checkForBooksWithContract(g, 1, p1Hand);
        const p2BookResult = checkForBooksWithContract(g, 2, p2Hand);

        log('Initial books checked', {
          p1Books: p1BookResult.booksScored,
          p2Books: p2BookResult.booksScored,
        });

        // Sync final state from contract
        const { turn, scores } = syncFromContract(g);

        setGameState(prev => ({
          ...prev,
          uiPhase: 'ready',
          contractPhase: ContractGamePhase.TurnStart,
          player1Hand: p1BookResult.updatedHand,
          player2Hand: p2BookResult.updatedHand,
          player1Score: scores[0],
          player2Score: scores[1],
          message: `✅ Game ready! Player ${turn} goes first.`,
          currentTurn: turn,
        }));
        
        log('Game initialization complete');

      } catch (error: any) {
        logError('Game initialization error', error);
        setGameState(prev => ({ ...prev, message: `❌ Error: ${error.message}` }));
      }
    };

    initGame();
  }, [applyMask, callDealCards, queryPlayerHand, checkForBooksWithContract, getContractPhase, syncFromContract]);

  // ============================================
  // TURN LOGIC
  // ============================================

  const prepareTurn = useCallback(() => {
    if (!game || gameState.loading) return;
    
    // Only allow actions during TurnStart phase
    const contractPhase = getContractPhase(game);
    if (contractPhase !== ContractGamePhase.TurnStart) {
      log('prepareTurn: not in TurnStart phase', { contractPhase });
      
      // Check if game is over
      if (contractPhase === ContractGamePhase.GameOver) {
        const scores = getContractScores(game);
        setGameState(prev => ({
          ...prev,
          contractPhase: ContractGamePhase.GameOver,
          player1Score: scores[0],
          player2Score: scores[1],
        }));
      }
      return;
    }

    // Get current turn from contract (this is the source of truth)
    const contractTurn = getContractTurn(game);
    log(`prepareTurn: contract says it is player ${contractTurn}'s turn`);
    
    // Update UI state if it's out of sync
    if (gameState.currentTurn !== contractTurn) {
      log('Syncing turn from contract', { ui: gameState.currentTurn, contract: contractTurn });
      setGameState(prev => ({ ...prev, currentTurn: contractTurn }));
    }

    const currentHand = contractTurn === 1 ? gameState.player1Hand : gameState.player2Hand;

    if (currentHand.length === 0) {
      if (!isDeckEmpty(game)) {
        // Draw a card if hand is empty (Go Fish to draw)
        handleDrawCardEmptyHand();
      } else {
        // Check if game should end
        if (checkAndEndGameContract(game)) {
          const scores = getContractScores(game);
          setGameState(prev => ({
            ...prev,
            contractPhase: ContractGamePhase.GameOver,
            player1Score: scores[0],
            player2Score: scores[1],
            message: '🏁 Game Over!',
          }));
        } else {
          // Switch turn via contract (pass current player for security)
          callSwitchTurn(game, contractTurn);
          const newTurn = getContractTurn(game);
          setGameState(prev => ({
            ...prev,
            currentTurn: newTurn,
            message: `Player ${contractTurn} has no cards. Player ${newTurn}'s turn.`,
          }));
        }
      }
      return;
    }

    // Setup rank selection - player can only ask for ranks they have
    const grouped = groupCardsByRank(currentHand);
    const ranks = Array.from(grouped.keys()).sort((a, b) => a - b);
    setAvailableRanks(ranks);
    setRankSelectionIndex(0);
    setInputMode('selectRank');
    setGameState(prev => ({ 
      ...prev, 
      contractPhase: ContractGamePhase.TurnStart,
      currentTurn: contractTurn,
      message: `Player ${contractTurn}, select a rank to ask for:` 
    }));
  }, [game, gameState, getContractPhase, getContractTurn, getContractScores, isDeckEmpty, checkAndEndGameContract, callSwitchTurn]);

  // Trigger prepareTurn when ready
  useEffect(() => {
    if (gameState.uiPhase === 'ready' && !gameState.loading && inputMode === 'none') {
      const timer = setTimeout(prepareTurn, 200);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [gameState.currentTurn, gameState.uiPhase, gameState.loading, inputMode, prepareTurn]);

  // ============================================
  // GAME ACTIONS
  // ============================================

  // Handle drawing when hand is empty (special case)
  const handleDrawCardEmptyHand = useCallback(async () => {
    if (!game || isDeckEmpty(game)) return;

    setGameState(prev => ({ ...prev, loading: true }));

    try {
      const currentPlayer = getContractTurn(game);
      const card = await drawCardGoFish(game, currentPlayer);
      const playerKey = currentPlayer === 1 ? 'player1Hand' : 'player2Hand';

      // Since hand was empty, drawn card doesn't match any "requested" rank
      // Call afterGoFish to switch turns (pass playerId for security)
      callAfterGoFish(game, currentPlayer, false);

      const newHand = [card];
      const { booksScored, updatedHand } = checkForBooksWithContract(game, currentPlayer, newHand);
      
      // Sync state from contract
      const { phase, turn, scores } = syncFromContract(game);

      setGameState(prev => ({
        ...prev,
        contractPhase: phase,
        currentTurn: turn,
        [playerKey]: updatedHand,
        player1Score: scores[0],
        player2Score: scores[1],
        message: `Drew: ${formatCard(card)}${booksScored.length > 0 ? ` 📚 BOOK: ${booksScored.map(r => getRankName(r)).join(', ')}!` : ''}`,
        loading: false,
      }));

      setInputMode('none');
    } catch (error: any) {
      logError('handleDrawCardEmptyHand error', error);
      setGameState(prev => ({ ...prev, message: `❌ Error: ${error.message}`, loading: false }));
    }
  }, [game, isDeckEmpty, getContractTurn, drawCardGoFish, callAfterGoFish, checkForBooksWithContract, syncFromContract]);

  // Handle drawing card during Go Fish (opponent didn't have the card)
  const handleGoFishDraw = useCallback(async (requestedRank: number) => {
    if (!game) return;
    
    const currentPlayer = getContractTurn(game);
    
    if (isDeckEmpty(game)) {
      // No cards to draw - just switch turns (pass current player for security)
      callSwitchTurn(game, currentPlayer);
      const { phase, turn, scores } = syncFromContract(game);
      setGameState(prev => ({
        ...prev,
        contractPhase: phase,
        currentTurn: turn,
        player1Score: scores[0],
        player2Score: scores[1],
        message: 'Deck is empty! Turn switches.',
        loading: false,
      }));
      return;
    }

    setGameState(prev => ({ ...prev, loading: true }));

    try {
      // Use contract's goFish circuit (enforces phase validation)
      const card = await drawCardGoFish(game, currentPlayer);
      const drawnRank = getCardRank(card);
      const playerKey = currentPlayer === 1 ? 'player1Hand' : 'player2Hand';

      // Check if drew the requested card
      const drewRequestedCard = drawnRank === requestedRank;
      
      // Tell contract whether we drew the requested card (handles turn logic)
      // Now passes playerId for security validation
      callAfterGoFish(game, currentPlayer, drewRequestedCard);

      // Update local hand and check for books
      const newHand = [...gameState[playerKey], card];
      const { booksScored, updatedHand } = checkForBooksWithContract(game, currentPlayer, newHand);

      // Check if game should end
      checkAndEndGameContract(game);
      
      // Sync state from contract
      const { phase, turn, scores } = syncFromContract(game);

      let message = `Drew: ${formatCard(card)}`;
      if (booksScored.length > 0) {
        message += ` 📚 BOOK: ${booksScored.map(r => getRankName(r)).join(', ')}!`;
      }
      if (drewRequestedCard) {
        message += ` 🎯 Lucky! Got the ${getRankName(requestedRank)} you asked for! Go again!`;
      } else {
        message += ` Player ${turn}'s turn.`;
      }

      setGameState(prev => ({
        ...prev,
        contractPhase: phase,
        currentTurn: turn,
        [playerKey]: updatedHand,
        player1Score: scores[0],
        player2Score: scores[1],
        message,
        loading: false,
        lastRequestedRank: null,
      }));

      setInputMode('none');
    } catch (error: any) {
      logError('handleGoFishDraw error', error);
      setGameState(prev => ({ ...prev, message: `❌ Error: ${error.message}`, loading: false }));
    }
  }, [game, gameState, isDeckEmpty, getContractTurn, drawCardGoFish, callAfterGoFish, callSwitchTurn, checkForBooksWithContract, checkAndEndGameContract, syncFromContract]);

  const handleAskForCards = useCallback(async (rank: number) => {
    if (!game) return;

    // Get current turn from contract (source of truth)
    const contractTurn = getContractTurn(game);
    log('handleAskForCards: contract turn', { contractTurn, uiTurn: gameState.currentTurn });

    const askingPlayer = contractTurn;
    const askedPlayer = askingPlayer === 1 ? 2 : 1;
    const askedHandKey = askedPlayer === 1 ? 'player1Hand' : 'player2Hand';
    const askingHandKey = askingPlayer === 1 ? 'player1Hand' : 'player2Hand';

    setInputMode('none');

    let result: { opponentHadCard: boolean; cardsTransferred: number };
    try {
      // =====================================================
      // TWO-STEP CONTRACT CALLS: askForCard + respondToAsk
      // Step 1 (askForCard - called by asking player):
      // - Validates: correct phase, correct turn, player has the rank
      // - Stores the asked rank and asking player ID
      // - Records pre-draw count for later verification
      // Step 2 (respondToAsk - called by opponent):
      // - Checks if opponent has the card
      // - If yes: transfers cards and keeps current player's turn
      // - If no: transitions to WaitForDraw phase
      // =====================================================
      result = callAskForCardAndProcess(game, contractTurn, rank);
      
    } catch (error: any) {
      // Contract assertion failed - display the error message
      log(error.stack);
      log('askForCard/respondToAsk failed', { error: error.message });
      setGameState(prev => ({
        ...prev,
        message: `❌ ${error.message}`,
      }));
      setInputMode('selectRank');
      return;
    }

    if (result.opponentHadCard) {
      // Opponent had cards! Contract already transferred them
      // Update UI hands to reflect contract state
      const opponentHand = gameState[askedHandKey];
      
      // Find transferred cards (all cards of this rank in opponent's hand)
      const transferredCards: bigint[] = [];
      for (let suit = 0; suit < 4; suit++) {
        const cardValue = BigInt(rank + suit * 13);
        if (opponentHand.includes(cardValue)) {
          transferredCards.push(cardValue);
        }
      }

      // Remove transferred cards from asked player's hand
      // Add transferred cards to asking player's hand
      const updatedAskedHand = gameState[askedHandKey].filter(
        c => !transferredCards.includes(c)
      );
      const updatedAskingHand = [...gameState[askingHandKey], ...transferredCards];

      // Check for books with contract validation
      const { booksScored, updatedHand: finalAskingHand } = checkForBooksWithContract(game, askingPlayer, updatedAskingHand);

      // Check if game should end
      checkAndEndGameContract(game);

      // Sync state from contract
      const { phase, turn, scores } = syncFromContract(game);

      let message = `✓ Player ${askedPlayer} had ${result.cardsTransferred} ${getRankName(rank)}${result.cardsTransferred > 1 ? 's' : ''}!`;
      if (booksScored.length > 0) {
        message += ` 📚 BOOK: ${booksScored.map(r => getRankName(r)).join(', ')}!`;
      }
      message += ` Player ${askingPlayer} goes again!`;

      setGameState(prev => ({
        ...prev,
        contractPhase: phase,
        currentTurn: turn,
        [askingHandKey]: finalAskingHand,
        [askedHandKey]: updatedAskedHand,
        player1Score: scores[0],
        player2Score: scores[1],
        message,
      }));
    } else {
      // Go Fish! Contract already transitioned to WaitForDraw phase
      setGameState(prev => ({
        ...prev,
        message: `🐟 GO FISH! Player ${askedPlayer} doesn't have any ${getRankName(rank)}s.`,
        lastRequestedRank: rank,
      }));

      // Draw a card after a brief delay
      setTimeout(() => {
        handleGoFishDraw(rank);
      }, 1000);
    }
  }, [game, gameState, getContractTurn, callAskForCardAndProcess, checkForBooksWithContract, checkAndEndGameContract, syncFromContract, handleGoFishDraw]);

  // ============================================
  // INPUT HANDLING
  // ============================================

  useInput((_input, key) => {
    // Only allow input when game is ready and not loading, and not game over
    if (gameState.uiPhase !== 'ready' || gameState.loading) return;
    if (gameState.contractPhase === ContractGamePhase.GameOver) return;

    if (inputMode === 'selectRank') {
      if (key.upArrow) {
        setRankSelectionIndex(prev => prev > 0 ? prev - 1 : availableRanks.length - 1);
      } else if (key.downArrow) {
        setRankSelectionIndex(prev => prev < availableRanks.length - 1 ? prev + 1 : 0);
      } else if (key.return) {
        const rank = availableRanks[rankSelectionIndex];
        if (rank !== undefined) {
          setSelectedRank(rank);
          setInputMode('confirmAsk');
          setGameState(prev => ({
            ...prev,
            message: `Ask Player ${prev.currentTurn === 1 ? 2 : 1} for ${getRankName(rank)}s? (Enter: Confirm, Esc: Cancel)`,
          }));
        }
      }
    } else if (inputMode === 'confirmAsk') {
      if (key.return && selectedRank !== null) {
        handleAskForCards(selectedRank);
      } else if (key.escape) {
        setInputMode('selectRank');
        setSelectedRank(null);
        setGameState(prev => ({
          ...prev,
          message: `Player ${prev.currentTurn}, select a rank to ask for:`,
        }));
      }
    }
  });

  // ============================================
  // RENDER HELPERS
  // ============================================

  const renderHand = (player: 1 | 2, showCards: boolean) => {
    const hand = player === 1 ? gameState.player1Hand : gameState.player2Hand;
    const score = player === 1 ? gameState.player1Score : gameState.player2Score;
    const isCurrentPlayer = gameState.currentTurn === player;
    const isPlaying = gameState.uiPhase === 'ready' && gameState.contractPhase === ContractGamePhase.TurnStart;
    const grouped = groupCardsByRank(hand);

    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text color={isCurrentPlayer ? 'green' : 'white'} bold={isCurrentPlayer}>
          👤 Player {player} {isCurrentPlayer && isPlaying ? '← Your Turn' : ''}
        </Text>
        <Text>
          {'  '}📚 Books: {score} {score > 0 ? `(${score} point${score > 1 ? 's' : ''})` : ''}
        </Text>
        {showCards && hand.length > 0 ? (
          <>
            <Text>{'  '}🃏 Hand ({hand.length} cards):</Text>
            {[...grouped.entries()].sort((a, b) => a[0] - b[0]).map(([rank, cards]) => (
              <Text key={rank} color={isCurrentPlayer ? 'green' : 'gray'}>
                {'     '}{getRankName(rank)}: {cards.map(c => formatCard(c)).join(' ')}
              </Text>
            ))}
          </>
        ) : !showCards ? (
          <Text>{'  '}🃏 Hand: {hand.length} cards (hidden)</Text>
        ) : (
          <Text>{'  '}🃏 Hand: Empty</Text>
        )}
      </Box>
    );
  };

  const renderRankSelector = () => {
    if (inputMode !== 'selectRank' || availableRanks.length === 0) return null;

    const currentHand = gameState.currentTurn === 1 ? gameState.player1Hand : gameState.player2Hand;
    const grouped = groupCardsByRank(currentHand);

    return (
      <Box flexDirection="column" marginTop={1}>
        <Text color="cyan">Select a rank to ask for:</Text>
        {availableRanks.map((rank, index) => {
          const count = grouped.get(rank)?.length || 0;
          const isSelected = index === rankSelectionIndex;
          return (
            <Text key={rank} color={isSelected ? 'green' : 'white'} bold={isSelected}>
              {isSelected ? '→ ' : '  '}{getRankName(rank)} ({count} card{count > 1 ? 's' : ''})
            </Text>
          );
        })}
        <Text color="gray" dimColor>↑/↓: Navigate | Enter: Select</Text>
      </Box>
    );
  };

  const renderLedgerState = () => {
    if (!game) return null;

    try {
      const deckRemaining = getDeckRemaining(game);
      const totalBooks = gameState.player1Score + gameState.player2Score;
      
      return (
        <Box flexDirection="column" borderStyle="round" borderColor="blue" padding={1} width="40%">
          <Text bold color="blue">📋 Game State (Contract)</Text>
          <Box marginTop={1} />
          <Text>🃏 Deck: {deckRemaining} cards</Text>
          <Text>📚 Total Books: {totalBooks}/13</Text>
          <Text>🔄 Turn: Player {gameState.currentTurn}</Text>
          <Text>📍 Phase: {getPhaseString(gameState.contractPhase)}</Text>
          <Box marginTop={1} />
          <Text color="gray" dimColor>─────────────────</Text>
          <Text color="cyan">Scores:</Text>
          <Text>  P1: {gameState.player1Score} | P2: {gameState.player2Score}</Text>
          <Box marginTop={1} />
          <Text color="gray" dimColor>─────────────────</Text>
          <Text color="cyan">Recent Contract Calls:</Text>
          {contractCallLog.length === 0 ? (
            <Text color="gray" dimColor>  (none yet)</Text>
          ) : (
            contractCallLog.map((call, i) => (
              <Text key={i} color="gray" dimColor>
                {i === contractCallLog.length - 1 ? '→ ' : '  '}{call}
              </Text>
            ))
          )}
        </Box>
      );
    } catch (err: any) {
      logError('renderLedgerState error', err);
      return (
        <Box flexDirection="column" borderStyle="round" borderColor="red" padding={1} width="40%">
          <Text bold color="red">📋 Error reading ledger</Text>
          <Text color="red">{err.message}</Text>
        </Box>
      );
    }
  };

  // ============================================
  // MAIN RENDER
  // ============================================

  // Setup/Loading screen
  if (gameState.uiPhase === 'initializing' || gameState.uiPhase === 'shuffling' || gameState.uiPhase === 'dealing') {
    return (
      <Box flexDirection="column" padding={1}>
        <Text bold color="cyan">🎮 GO FISH</Text>
        <Box marginTop={1} />
        <Text color="yellow">{gameState.message}</Text>
        <Box marginTop={1} />
        <Text color="gray">Setting up game...</Text>
        <Text color="gray" dimColor>Contract Phase: {getPhaseString(gameState.contractPhase)}</Text>
      </Box>
    );
  }

  // Game Over screen
  if (gameState.contractPhase === ContractGamePhase.GameOver) {
    const p1Score = gameState.player1Score;
    const p2Score = gameState.player2Score;
    const winner = p1Score > p2Score ? 1 : p2Score > p1Score ? 2 : null;

    return (
      <Box flexDirection="column" padding={1}>
        <Text bold color="red">🏁 GAME OVER!</Text>
        <Box marginTop={1} />
        {renderHand(1, true)}
        {renderHand(2, true)}
        <Box marginTop={1} />
        <Text bold color="yellow">
          Final Score: Player 1: {p1Score} books | Player 2: {p2Score} books
        </Text>
        {winner ? (
          <Text bold color="green">🎉 Player {winner} WINS!</Text>
        ) : (
          <Text bold color="yellow">🤝 It's a TIE!</Text>
        )}
        <Box marginTop={1} />
        <Text>Thanks for playing GO FISH!</Text>
        <Text color="gray" dimColor>Contract validated all game rules ✓</Text>
      </Box>
    );
  }

  // Main game screen
  return (
    <Box flexDirection="row" width="100%">
      <Box flexDirection="column" padding={1} width="60%">
        <Text bold color="cyan">🎮 GO FISH</Text>
        <Box marginTop={1} />
        
        {renderHand(1, true)}
        {renderHand(2, true)}
        
        <Box marginTop={1} borderStyle="round" borderColor="gray" padding={1}>
          <Box flexDirection="column">
            <Text color="yellow" bold>{gameState.message}</Text>
            {gameState.loading && <Text color="yellow">Processing...</Text>}
            {renderRankSelector()}
            {inputMode === 'confirmAsk' && selectedRank !== null && (
              <Box flexDirection="column" marginTop={1}>
                <Text color="cyan">
                  Ask Player {gameState.currentTurn === 1 ? 2 : 1} for {getRankName(selectedRank)}s?
                </Text>
                <Text color="gray" dimColor>Enter: Confirm | Esc: Cancel</Text>
              </Box>
            )}
          </Box>
        </Box>
      </Box>
      
      {renderLedgerState()}
    </Box>
  );
}
