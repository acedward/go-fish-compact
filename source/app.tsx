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
import { witnesses, type PrivateState } from './witnesses.js';
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
// SIMULATOR CLASS
// ============================================

class GoFishGame {
  readonly contract: Contract<PrivateState, Witnesses<PrivateState>>;
  circuitContext: CircuitContext<PrivateState>;

  constructor() {
    log('GoFishGame constructor started');
    
    try {
      log('Creating Contract instance...');
      this.contract = new Contract<PrivateState, Witnesses<PrivateState>>(
        witnesses,
      );
      log('Contract instance created');
      
      log('Calling initialState...');
      const initialStateResult = this.contract.initialState(createConstructorContext({}, '0'.repeat(64)));
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

  get circuits() {
    return this.contract.circuits;
  }

  get impureCircuits() {
    return this.contract.impureCircuits;
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

  // ============================================
  // CONTRACT INTERACTION FUNCTIONS
  // ============================================

  const applyMask = useCallback(async (g: GoFishGame, playerId: number) => {
    const r = g.impureCircuits.applyMask(g.circuitContext, BigInt(playerId));
    g.circuitContext = r.context;
  }, []);

  // Get current game phase from contract
  const getContractPhase = useCallback((g: GoFishGame): ContractGamePhaseValue => {
    const r = g.circuits.getGamePhase(g.circuitContext);
    g.circuitContext = r.context;
    return r.result as ContractGamePhaseValue;
  }, []);

  // Get current turn from contract
  const getContractTurn = useCallback((g: GoFishGame): 1 | 2 => {
    const r = g.circuits.getCurrentTurn(g.circuitContext);
    g.circuitContext = r.context;
    return Number(r.result) as 1 | 2;
  }, []);

  // Get scores from contract
  const getContractScores = useCallback((g: GoFishGame): [number, number] => {
    const r = g.circuits.getScores(g.circuitContext);
    g.circuitContext = r.context;
    return [Number(r.result[0]), Number(r.result[1])];
  }, []);

  // Validate that the asking player has at least one card of the requested rank
  const validatePlayerHasRank = useCallback((g: GoFishGame, playerId: number, rank: number): boolean => {
    const r = g.circuits.doesPlayerHaveCard(g.circuitContext, BigInt(playerId), BigInt(rank));
    g.circuitContext = r.context;
    return r.result;
  }, []);

  // Start the game (transition from Setup to TurnStart)
  const callStartGame = useCallback((g: GoFishGame) => {
    log('Calling contract startGame()');
    const r = g.circuits.startGame(g.circuitContext);
    g.circuitContext = r.context;
    log('startGame completed');
  }, []);

  // Draw card during setup phase (uses dealCard which tracks dealt cards)
  const drawCardSetup = useCallback(async (g: GoFishGame, playerId: number): Promise<bigint> => {
    log(`Drawing card for player ${playerId} during setup (using dealCard)`);
    
    // Use dealCard which:
    // 1. Asserts we're in Setup phase
    // 2. Gets the top card for the player
    // 3. Calls markCardDealt to increment the counter (required for startGame)
    const r1 = g.circuits.dealCard(g.circuitContext, BigInt(playerId));
    g.circuitContext = r1.context;
    const encryptedPoint = r1.result;

    // Decrypt with player's key
    const r2 = g.circuits.partial_decryption(g.circuitContext, encryptedPoint, BigInt(playerId));
    g.circuitContext = r2.context;
    const decryptedPoint = r2.result;

    // Get card value
    const r3 = g.circuits.get_card_from_point(g.circuitContext, decryptedPoint);
    g.circuitContext = r3.context;
    return r3.result;
  }, []);

  // Draw card during "Go Fish" - uses the contract's goFish circuit which enforces phase
  const drawCardGoFish = useCallback(async (g: GoFishGame, playerId: number): Promise<bigint> => {
    log(`Player ${playerId} going fishing (contract goFish circuit)`);
    
    // Use the contract's goFish circuit which enforces phase validation
    const r1 = g.circuits.goFish(g.circuitContext, BigInt(playerId));
    g.circuitContext = r1.context;
    const encryptedPoint = r1.result;

    // Decrypt with player's key
    const r2 = g.circuits.partial_decryption(g.circuitContext, encryptedPoint, BigInt(playerId));
    g.circuitContext = r2.context;
    const decryptedPoint = r2.result;

    // Get card value
    const r3 = g.circuits.get_card_from_point(g.circuitContext, decryptedPoint);
    g.circuitContext = r3.context;
    return r3.result;
  }, []);

  // Call afterGoFish to notify contract whether drawn card matched
  const callAfterGoFish = useCallback((g: GoFishGame, drewRequestedCard: boolean) => {
    log(`Calling afterGoFish with drewRequestedCard=${drewRequestedCard}`);
    const r = g.circuits.afterGoFish(g.circuitContext, drewRequestedCard);
    g.circuitContext = r.context;
  }, []);

  // Call opponentHadCard when opponent has the requested cards
  const callOpponentHadCard = useCallback((g: GoFishGame) => {
    log('Calling opponentHadCard - player gets another turn');
    const r = g.circuits.opponentHadCard(g.circuitContext);
    g.circuitContext = r.context;
  }, []);

  // Call switchTurn to switch to other player
  const callSwitchTurn = useCallback((g: GoFishGame) => {
    log('Calling switchTurn');
    const r = g.circuits.switchTurn(g.circuitContext);
    g.circuitContext = r.context;
  }, []);

  // Check and score a book using contract
  const checkAndScoreBookContract = useCallback((g: GoFishGame, playerId: number, rank: number): boolean => {
    log(`Checking for book: player ${playerId}, rank ${rank}`);
    const r = g.circuits.checkAndScoreBook(g.circuitContext, BigInt(playerId), BigInt(rank));
    g.circuitContext = r.context;
    return r.result;
  }, []);

  // Check if game should end
  const checkAndEndGameContract = useCallback((g: GoFishGame): boolean => {
    const r = g.circuits.checkAndEndGame(g.circuitContext);
    g.circuitContext = r.context;
    return r.result;
  }, []);

  const getDeckRemaining = useCallback((g: GoFishGame): number => {
    try {
      log('getDeckRemaining called');
      const sizeResult = g.circuits.get_deck_size(g.circuitContext);
      log('get_deck_size result', { hasResult: !!sizeResult, result: String(sizeResult?.result) });
      const size = sizeResult.result;
      
      const indexResult = g.circuits.get_top_card_index(g.circuitContext);
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

        // Phase 2: Dealing (7 cards each)
        log('Starting Phase 2: Dealing');
        setGameState(prev => ({ ...prev, uiPhase: 'dealing', message: '🃏 Dealing cards...' }));
        
        const p1Hand: bigint[] = [];
        const p2Hand: bigint[] = [];

        // Deal 7 cards to each player using setup draw
        for (let i = 0; i < 7; i++) {
          log(`Drawing card ${i + 1} for player 1...`);
          const card1 = await drawCardSetup(g, 1);
          log(`Player 1 drew card: ${card1}`);
          p1Hand.push(card1);
          
          log(`Drawing card ${i + 1} for player 2...`);
          const card2 = await drawCardSetup(g, 2);
          log(`Player 2 drew card: ${card2}`);
          p2Hand.push(card2);
        }

        log('Dealing complete', { p1Hand: p1Hand.map(String), p2Hand: p2Hand.map(String) });

        // IMPORTANT: Call startGame() to transition contract from Setup to TurnStart
        log('Calling startGame() to transition contract to TurnStart phase');
        callStartGame(g);
        
        // Verify contract transitioned correctly
        const phaseAfterStart = getContractPhase(g);
        log('Contract phase after startGame', { phase: phaseAfterStart });
        if (phaseAfterStart !== ContractGamePhase.TurnStart) {
          throw new Error(`startGame did not transition to TurnStart, got: ${phaseAfterStart}`);
        }

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
  }, [applyMask, drawCardSetup, checkForBooksWithContract, callStartGame, getContractPhase, syncFromContract]);

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
          // Switch turn via contract
          callSwitchTurn(game);
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
      // Call afterGoFish to switch turns
      callAfterGoFish(game, false);

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
    if (!game || isDeckEmpty(game)) {
      // No cards to draw - just switch turns
      callSwitchTurn(game!);
      const { phase, turn, scores } = syncFromContract(game!);
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
      const currentPlayer = getContractTurn(game);
      
      // Use contract's goFish circuit (enforces phase validation)
      const card = await drawCardGoFish(game, currentPlayer);
      const drawnRank = getCardRank(card);
      const playerKey = currentPlayer === 1 ? 'player1Hand' : 'player2Hand';

      // Check if drew the requested card
      const drewRequestedCard = drawnRank === requestedRank;
      
      // Tell contract whether we drew the requested card (handles turn logic)
      callAfterGoFish(game, drewRequestedCard);

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

    // VALIDATION 1: Get current turn from contract (source of truth)
    const contractTurn = getContractTurn(game);
    log('handleAskForCards: contract turn', { contractTurn, uiTurn: gameState.currentTurn });
    
    // VALIDATION 2: Verify contract is in correct phase
    const contractPhase = getContractPhase(game);
    if (contractPhase !== ContractGamePhase.TurnStart) {
      setGameState(prev => ({
        ...prev,
        message: `❌ Cannot ask for cards - wrong phase (${getPhaseString(contractPhase)})`,
      }));
      return;
    }

    // VALIDATION 3: Verify asking player has at least one card of the requested rank
    // This is the key rule: "Can only ask if the opponent has a card If I have one in hand"
    const hasRank = validatePlayerHasRank(game, contractTurn, rank);
    if (!hasRank) {
      setGameState(prev => ({
        ...prev,
        message: `❌ You can only ask for ranks you have in your hand!`,
      }));
      setInputMode('selectRank');
      return;
    }

    const askingPlayer = contractTurn;
    const askedPlayer = askingPlayer === 1 ? 2 : 1;
    const askedHand = askedPlayer === 1 ? gameState.player1Hand : gameState.player2Hand;
    const askingHand = askingPlayer === 1 ? gameState.player1Hand : gameState.player2Hand;

    // Find cards of the requested rank in opponent's hand
    const cardsToTransfer = askedHand.filter(c => getCardRank(c) === rank);

    setInputMode('none');
    setGameState(prev => ({ ...prev, lastRequestedRank: rank }));

    if (cardsToTransfer.length > 0) {
      // Opponent has the cards! Transfer them
      log(`Player ${askedPlayer} has ${cardsToTransfer.length} ${getRankName(rank)}(s) to transfer`);
      
      const remainingAskedHand = askedHand.filter(c => getCardRank(c) !== rank);
      const newAskingHand = [...askingHand, ...cardsToTransfer];

      // Tell contract that opponent had the card (player gets another turn)
      callOpponentHadCard(game);

      // Check for books with contract validation
      const { booksScored, updatedHand } = checkForBooksWithContract(game, askingPlayer, newAskingHand);

      // Check if game should end
      checkAndEndGameContract(game);

      // Sync state from contract
      const { phase, turn, scores } = syncFromContract(game);

      let message = `✓ Player ${askedPlayer} had ${cardsToTransfer.length} ${getRankName(rank)}${cardsToTransfer.length > 1 ? 's' : ''}!`;
      if (booksScored.length > 0) {
        message += ` 📚 BOOK: ${booksScored.map(r => getRankName(r)).join(', ')}!`;
      }
      message += ` Player ${askingPlayer} goes again!`;

      setGameState(prev => ({
        ...prev,
        contractPhase: phase,
        currentTurn: turn,
        [askingPlayer === 1 ? 'player1Hand' : 'player2Hand']: updatedHand,
        [askedPlayer === 1 ? 'player1Hand' : 'player2Hand']: remainingAskedHand,
        player1Score: scores[0],
        player2Score: scores[1],
        message,
      }));
    } else {
      // Go Fish! Opponent doesn't have the card
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
  }, [game, gameState, getContractTurn, getContractPhase, validatePlayerHasRank, callOpponentHadCard, checkForBooksWithContract, checkAndEndGameContract, syncFromContract, handleGoFishDraw]);

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
