import React, { useState, useEffect } from 'react';
import { Box, Text, useInput } from 'ink';
import {
  getCardRank,
  getRankName,
  formatCard,
  groupCardsByRank,
  checkForBooks,
  removeCardsOfRank,
  initializeDeck,
  shuffleDeck,
  dealInitialCards,
  drawCardFromDeck as drawCardFromDeckGame,
  hasCardsRemaining as hasCardsRemainingGame,
} from './go-fish.interactive.js';
import { ledger } from '../go-fish/contract/index.js';
import { CardSimulator } from './card-simulator.js';
type GamePhase = 'setup' | 'playing' | 'ended';
type GameState = {
  phase: GamePhase;
  currentTurn: number;
  playerHands: {
    player1: bigint[];
    player2: bigint[];
  };
  books: {
    player1: number[];
    player2: number[];
  };
  deckInitialized: boolean;
  player1Shuffled: boolean;
  player2Shuffled: boolean;
};

type InputMode = 'none' | 'selectRank' | 'confirmAsk';

type Props = {
  name?: string;
};

export default function App(_props: Props) {
  const [simulator, setSimulator] = useState<CardSimulator | null>(null);
  const [gameState, setGameState] = useState<GameState>({
    phase: 'setup',
    currentTurn: 1,
    playerHands: {
      player1: [],
      player2: [],
    },
    books: {
      player1: [],
      player2: [],
    },
    deckInitialized: false,
    player1Shuffled: false,
    player2Shuffled: false,
  });
  const [message, setMessage] = useState<string>('');
  const [inputMode, setInputMode] = useState<InputMode>('none');
  const [selectedRank, setSelectedRank] = useState<number | null>(null);
  const [availableRanks, setAvailableRanks] = useState<number[]>([]);
  const [rankSelectionIndex, setRankSelectionIndex] = useState<number>(0);
  const [loading, setLoading] = useState<boolean>(false);

  // Initialize simulator
  useEffect(() => {
    const sim = new CardSimulator();
    setSimulator(sim);
    initializeGame(sim);
  }, []);

  const initializeGame = async (sim: CardSimulator) => {
    setMessage('🎮 Welcome to GO FISH! Setting up the game...');
    setLoading(true);

    try {
      // Initialize deck
      const initResult = await initializeDeck(sim);
      if (!initResult.success) {
        setMessage('❌ Failed to initialize deck');
        setLoading(false);
        return;
      }
      sim.circuitContext = initResult.context;
      setGameState((prev) => ({ ...prev, deckInitialized: true }));
      setMessage('✓ Deck initialized');

      // Player 1 shuffles
      const shuffle1Result = await shuffleDeck(sim, 1);
      if (!shuffle1Result.success) {
        setMessage('❌ Failed to shuffle (Player 1)');
        setLoading(false);
        return;
      }
      sim.circuitContext = shuffle1Result.context;
      setGameState((prev) => ({ ...prev, player1Shuffled: true }));
      setMessage('✓ Player 1 shuffled');

      // Player 2 shuffles
      const shuffle2Result = await shuffleDeck(sim, 2);
      if (!shuffle2Result.success) {
        setMessage('❌ Failed to shuffle (Player 2)');
        setLoading(false);
        return;
      }
      sim.circuitContext = shuffle2Result.context;
      setGameState((prev) => ({ ...prev, player2Shuffled: true }));
      setMessage('✓ Player 2 shuffled');

      // Deal cards
      const dealResult = await dealInitialCards(sim, drawCardFromDeckGame, hasCardsRemainingGame);
      if (!dealResult.success) {
        setMessage('❌ Failed to deal cards');
        setLoading(false);
        return;
      }
      sim.circuitContext = dealResult.context;

      setGameState((prev) => ({
        ...prev,
        playerHands: dealResult.hands,
        phase: 'playing',
      }));

      // Check for initial books
      checkAndRemoveBooks(1, dealResult.hands.player1);
      checkAndRemoveBooks(2, dealResult.hands.player2);

      setMessage('✅ Game setup complete! Player 1 goes first.');
      setLoading(false);
      // useEffect will handle prepareTurn when phase changes to 'playing'
    } catch (error: any) {
      setMessage(`❌ Error: ${error.message}`);
      setLoading(false);
    }
  };

  // Using exported functions from go-fish.interactive.ts
  const drawCardFromDeck = drawCardFromDeckGame;
  const hasCardsRemaining = (sim: CardSimulator | null): boolean => {
    if (!sim) return false;
    return hasCardsRemainingGame(sim);
  };

  const checkAndRemoveBooks = (player: number, hand: bigint[]) => {
    const playerKey = player === 1 ? 'player1' : 'player2';
    setGameState((prev) => {
      const existingBooks = prev.books[playerKey];
      const newBooks = checkForBooks(hand, existingBooks);
      if (newBooks.length > 0) {
        let updatedHand = hand;
        const updatedBooks = [...existingBooks];
        for (const rank of newBooks) {
          const { remaining } = removeCardsOfRank(updatedHand, rank);
          updatedHand = remaining;
          updatedBooks.push(rank);
        }
        return {
          ...prev,
          playerHands: {
            ...prev.playerHands,
            [playerKey]: updatedHand,
          },
          books: {
            ...prev.books,
            [playerKey]: updatedBooks,
          },
        };
      }
      return prev;
    });
  };

  const checkGameEnd = (): boolean => {
    const totalBooks = gameState.books.player1.length + gameState.books.player2.length;
    if (totalBooks >= 13) return true;

    const p1HandEmpty = gameState.playerHands.player1.length === 0;
    const p2HandEmpty = gameState.playerHands.player2.length === 0;
    const deckEmpty = !hasCardsRemaining(simulator);

    return (p1HandEmpty || p2HandEmpty) && deckEmpty;
  };

  const getWinner = (): { player: number; score: number } | null => {
    const p1Score = gameState.books.player1.length;
    const p2Score = gameState.books.player2.length;

    if (p1Score > p2Score) return { player: 1, score: p1Score };
    if (p2Score > p1Score) return { player: 2, score: p2Score };
    return null;
  };

  const prepareTurn = () => {
    if (gameState.phase !== 'playing' || loading) return;
    
    const currentPlayer = gameState.currentTurn;
    const currentHand = gameState.playerHands[currentPlayer === 1 ? 'player1' : 'player2'];

    if (currentHand.length === 0) {
      if (hasCardsRemaining(simulator) && simulator) {
        handleDrawCard(currentPlayer);
        return;
      } else {
        // Switch turns if no cards and deck empty
        setGameState((prev) => ({
          ...prev,
          currentTurn: prev.currentTurn === 1 ? 2 : 1,
        }));
        return;
      }
    }

    // Player has cards - prepare for input
    const grouped = groupCardsByRank(currentHand);
    const ranks = Array.from(grouped.keys()).sort((a: number, b: number) => a - b);
    setAvailableRanks(ranks);
    setRankSelectionIndex(0);
    setInputMode('selectRank');
    setMessage(`Player ${currentPlayer}, select a rank to ask for:`);
  };

  // Use useEffect to prepare turn when it changes or when loading finishes
  useEffect(() => {
    if (gameState.phase === 'playing' && !loading && inputMode === 'none') {
      // Small delay to ensure state is updated
      const timer = setTimeout(() => {
        prepareTurn();
      }, 100);
      return () => clearTimeout(timer);
    }
    return undefined;
  }, [gameState.currentTurn, gameState.phase, loading, inputMode]);

  const handleDrawCard = async (player: number, requestedRank?: number) => {
    if (!simulator || !hasCardsRemaining(simulator)) {
      setMessage('Deck is empty.');
      setGameState((prev) => ({
        ...prev,
        currentTurn: prev.currentTurn === 1 ? 2 : 1,
      }));
      return; // useEffect will handle prepareTurn
    }

    setLoading(true);
    try {
      const card = await drawCardFromDeck(simulator, player);
      const playerKey = player === 1 ? 'player1' : 'player2';
      setGameState((prev) => {
        const newHand = [...prev.playerHands[playerKey], card];
        return {
          ...prev,
          playerHands: {
            ...prev.playerHands,
            [playerKey]: newHand,
          },
        };
      });
      checkAndRemoveBooks(player, [...gameState.playerHands[playerKey], card]);
      
      const drawnRank = getCardRank(card);
      
      // If this was a GO FISH draw, check if it matches the requested rank
      if (requestedRank !== undefined) {
        if (drawnRank === requestedRank) {
          setMessage(`✓ Drew: ${formatCard(card)} 🎉 Lucky! You got the ${getRankName(requestedRank)} you asked for!`);
          setLoading(false);
          
          if (checkGameEnd()) {
            endGame();
            return;
          }
          // Player continues turn - useEffect will handle prepareTurn
          return;
        } else {
          setMessage(`✓ Drew: ${formatCard(card)} (Not the ${getRankName(requestedRank)} you asked for)`);
          setLoading(false);
          
          if (checkGameEnd()) {
            endGame();
            return;
          }
          // Switch turns - player didn't get what they asked for
          setGameState((prev) => ({
            ...prev,
            currentTurn: prev.currentTurn === 1 ? 2 : 1,
          }));
          return;
        }
      }
      
      // Regular draw (not from GO FISH)
      setMessage(`✓ Drew: ${formatCard(card)}`);
      setLoading(false);

      if (checkGameEnd()) {
        endGame();
        return;
      }
      // useEffect will handle prepareTurn when state updates
    } catch (error: any) {
      setMessage(`❌ Error: ${error.message}`);
      setLoading(false);
    }
  };

  const processAskForCards = async (askingPlayer: number, askedPlayer: number, rank: number) => {
    if (!simulator) return;

    setLoading(true);
    setInputMode('none');

    try {
      // Check if player has card (simplified - using local state)
      const askedHand = gameState.playerHands[askedPlayer === 1 ? 'player1' : 'player2'];
      const { removed, remaining } = removeCardsOfRank(askedHand, rank);

      if (removed.length > 0) {
        // Player has the cards
        const askingHand = gameState.playerHands[askingPlayer === 1 ? 'player1' : 'player2'];
        setGameState((prev) => ({
          ...prev,
          playerHands: {
            ...prev.playerHands,
            [askingPlayer === 1 ? 'player1' : 'player2']: [...askingHand, ...removed],
            [askedPlayer === 1 ? 'player1' : 'player2']: remaining,
          },
        }));

        const newAskingHand = [...askingHand, ...removed];
        checkAndRemoveBooks(askingPlayer, newAskingHand);

        setMessage(
          `✓ Player ${askedPlayer} has ${removed.length} ${getRankName(rank)}${
            removed.length > 1 ? 's' : ''
          }!`
        );
        setLoading(false);

        if (checkGameEnd()) {
          endGame();
          return;
        }

        // Player continues turn - useEffect will handle prepareTurn
      } else {
        // GO Fish!
        setMessage(`🐟 GO FISH! Player ${askedPlayer} doesn't have any ${getRankName(rank)}s.`);
        setLoading(false);

        if (hasCardsRemaining(simulator)) {
          setTimeout(() => {
            handleDrawCard(askingPlayer, rank); // Pass the requested rank
          }, 1500);
        } else {
          setMessage('Deck is empty. No card to draw.');
          setGameState((prev) => ({
            ...prev,
            currentTurn: prev.currentTurn === 1 ? 2 : 1,
          }));
          // useEffect will handle prepareTurn
        }
      }
    } catch (error: any) {
      setMessage(`❌ Error: ${error.message}`);
      setLoading(false);
    }
  };

  const endGame = () => {
    setGameState((prev) => ({ ...prev, phase: 'ended' }));
    const winner = getWinner();
    if (winner) {
      setMessage(`🏁 GAME OVER! Player ${winner.player} WINS with ${winner.score} book(s)!`);
    } else {
      setMessage("🏁 GAME OVER! It's a TIE!");
    }
    setInputMode('none');
  };

  // Handle keyboard input
  useInput(
    (_input, key) => {
      if (gameState.phase === 'ended' || loading) return;

      if (inputMode === 'selectRank') {
          if (key.upArrow) {
            setRankSelectionIndex((prev) =>
              prev > 0 ? prev - 1 : availableRanks.length - 1
            );
          } else if (key.downArrow) {
            setRankSelectionIndex((prev) =>
              prev < availableRanks.length - 1 ? prev + 1 : 0
            );
          } else if (key.return) {
            const rank = availableRanks[rankSelectionIndex];
            if (rank !== undefined) {
              setSelectedRank(rank);
              setInputMode('confirmAsk');
              setMessage(
                `Ask Player ${gameState.currentTurn === 1 ? 2 : 1} for ${getRankName(rank)}s? (Press Enter to confirm, Esc to cancel)`
              );
            }
          } else if (key.escape) {
            setInputMode('none');
            setMessage('Action cancelled.');
          }
        } else if (inputMode === 'confirmAsk') {
          if (key.return) {
            const askingPlayer = gameState.currentTurn;
            const askedPlayer = askingPlayer === 1 ? 2 : 1;
            if (selectedRank !== null) {
              processAskForCards(askingPlayer, askedPlayer, selectedRank);
            }
          } else if (key.escape) {
            setInputMode('selectRank');
            setSelectedRank(null);
            setMessage('Player ' + gameState.currentTurn + ', select a rank to ask for:');
          }
        }
      }
  );

  const displayPlayerHand = (player: number, showCards: boolean) => {
    const playerKey = player === 1 ? 'player1' : 'player2';
    const hand = gameState.playerHands[playerKey];
    const books = gameState.books[playerKey];
    const isCurrentPlayer = gameState.currentTurn === player;

    const grouped = showCards && hand.length > 0 ? groupCardsByRank(hand) : new Map<number, bigint[]>();
    const handDisplay: string[] = [];

    if (showCards && hand.length > 0) {
      for (const [rank, cards] of Array.from(grouped.entries()).sort((a: [number, bigint[]], b: [number, bigint[]]) => a[0] - b[0])) {
        const cardsDisplay = cards.map((c: bigint) => formatCard(c)).join(' ');
        handDisplay.push(`${getRankName(rank)}: ${cardsDisplay}`);
      }
    }

    return (
      <Box flexDirection="column" marginBottom={1}>
        <Text>
          <Text color={isCurrentPlayer ? 'green' : 'white'}>
            👤 Player {player} {isCurrentPlayer ? '(Your Turn)' : ''}
          </Text>
        </Text>
        <Text>
          {'  '}📚 Books ({books.length}):{' '}
          {books.length > 0 ? books.map((r) => getRankName(r)).join(', ') : 'None'}
        </Text>
        {showCards && hand.length > 0 ? (
          <>
            <Text>{'  '}🃏 Hand ({hand.length} cards):</Text>
            {handDisplay.map((line, idx) => (
              <Text key={idx} color={isCurrentPlayer ? 'green' : 'white'}>
                {'     '}{line}
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

  const getDeckRemaining = (): number => {
    if (!simulator) return 0;
    try {
      const contractLedger = ledger(simulator.circuitContext.currentQueryContext.state);
      return Number(contractLedger.deckSize - contractLedger.topCardIndex);
    } catch {
      return 0;
    }
  };

  const displayLedgerState = () => {
    if (!simulator) {
      return (
        <Box flexDirection="column" padding={1} borderStyle="round" borderColor="gray" width="50%">
          <Text color="red">No simulator</Text>
        </Box>
      );
    }

    try {
      const contractLedger = ledger(simulator.circuitContext.currentQueryContext.state);
      const player1HandSize = Number(contractLedger.player1Hand.size());
      const player2HandSize = Number(contractLedger.player2Hand.size());
      const playersKeysCount = Number(contractLedger.playersKeysHashes.size());
      const deckSize = Number(contractLedger.deckSize);
      const topCardIndex = Number(contractLedger.topCardIndex);
      const remaining = deckSize - topCardIndex;

      // Get upcoming cards from deck starting at topCardIndex
      const upcomingCards: Array<{ index: number; point: { x: bigint; y: bigint } | null; cardValue: number | null }> = [];
      const numCardsToShow = Math.min(10, remaining); // Show up to 10 upcoming cards
      
      for (let i = 0; i < numCardsToShow; i++) {
        const cardIndex = topCardIndex + i;
        if (cardIndex < deckSize) {
          try {
            const point = contractLedger.deck.lookup(BigInt(cardIndex));
            let cardValue: number | null = null;
            
            // Try to get card value from the point (if it's in the mapping)
            try {
              if (contractLedger.deckCurveToCard.member(point)) {
                cardValue = Number(contractLedger.deckCurveToCard.lookup(point));
              }
            } catch {
              // Card might be encrypted, so we can't get the value
            }
            
            upcomingCards.push({
              index: cardIndex,
              point: point,
              cardValue: cardValue,
            });
          } catch {
            // Card not found or error accessing
            upcomingCards.push({
              index: cardIndex,
              point: null,
              cardValue: null,
            });
          }
        }
      }

      return (
        <Box flexDirection="column" padding={1} borderStyle="round" borderColor="blue" width="50%">
          <Text bold color="blue">
            📋 Contract Ledger State
          </Text>
          <Box marginTop={1} />
          <Text color="cyan">Deck:</Text>
          <Text>{'  '}Size: {deckSize}</Text>
          <Text>{'  '}Top Card Index: {topCardIndex}</Text>
          <Text>{'  '}Remaining: {remaining}</Text>
          <Box marginTop={1} />
          {upcomingCards.length > 0 && (
            <>
              <Text color="cyan">Upcoming Cards (next {numCardsToShow}):</Text>
              {upcomingCards.map((card, idx) => (
                <Box key={idx} flexDirection="column" marginLeft={2}>
                  <Text>
                    {'  '}[{card.index}]{' '}
                    {card.cardValue !== null ? (
                      <>
                        Card: {formatCard(BigInt(card.cardValue))} (Rank: {getRankName(getCardRank(BigInt(card.cardValue)))})
                      </>
                    ) : card.point ? (
                      <>
                        Point: ({String(card.point.x).slice(0, 10)}..., {String(card.point.y).slice(0, 10)}...)
                        <Text color="gray" dimColor> (encrypted)</Text>
                      </>
                    ) : (
                      <Text color="red">Error reading card</Text>
                    )}
                  </Text>
                </Box>
              ))}
              <Box marginTop={1} />
            </>
          )}
          <Text color="cyan">Player Hands:</Text>
          <Text>{'  '}Player 1: {player1HandSize} cards</Text>
          <Text>{'  '}Player 2: {player2HandSize} cards</Text>
          <Box marginTop={1} />
          <Text color="cyan">Shuffles:</Text>
          <Text>{'  '}Players shuffled: {playersKeysCount}/2</Text>
          <Box marginTop={1} />
          <Text color="cyan">Maps:</Text>
          <Text>{'  '}deckCurveToCard: {Number(contractLedger.deckCurveToCard.size())} entries</Text>
          <Text>{'  '}reverseDeckCurveToCard: {Number(contractLedger.reverseDeckCurveToCard.size())} entries</Text>
          <Text>{'  '}deck: {Number(contractLedger.deck.size())} entries</Text>
        </Box>
      );
    } catch (error: any) {
      return (
        <Box flexDirection="column" padding={1} borderStyle="round" borderColor="red" width="50%">
          <Text color="red">Error reading ledger: {error.message}</Text>
        </Box>
      );
    }
  };

  if (gameState.phase === 'setup' || !simulator) {
    return (
      <Box flexDirection="row" width="100%">
        <Box flexDirection="column" padding={1} width="50%">
          <Text>{message || 'Initializing game...'}</Text>
          {loading && <Text color="yellow">Loading...</Text>}
        </Box>
        {simulator && displayLedgerState()}
      </Box>
    );
  }

  if (gameState.phase === 'ended') {
    const winner = getWinner();
    return (
      <Box flexDirection="row" width="100%">
        <Box flexDirection="column" padding={1} width="50%">
          <Text color="red" bold>
            🏁 GAME OVER!
          </Text>
          <Box marginTop={1} />
          {displayPlayerHand(1, true)}
          {displayPlayerHand(2, true)}
          <Box marginTop={1} />
          {winner ? (
            <Text color="green" bold>
              🎉 Player {winner.player} WINS with {winner.score} book(s)!
            </Text>
          ) : (
            <Text color="yellow" bold>
              🤝 It's a TIE!
            </Text>
          )}
          <Box marginTop={1} />
          <Text>Thanks for playing GO FISH!</Text>
        </Box>
        {displayLedgerState()}
      </Box>
    );
  }

  return (
    <Box flexDirection="row" width="100%">
      {/* Left side: Game */}
      <Box flexDirection="column" padding={1} width="50%">
        <Text bold color="cyan">
          🎮 GO FISH - Current Turn: Player {gameState.currentTurn}
        </Text>
        <Box marginTop={1} />
        {displayPlayerHand(1, true)}
        {displayPlayerHand(2, true)}
        <Box marginTop={1} />
        <Text>📚 Deck: {getDeckRemaining()} cards remaining</Text>
        <Box marginTop={1} />
        <Box borderStyle="round" borderColor="gray" padding={1}>
          <Box flexDirection="column">
            {message && (
              <Text color="yellow" bold>
                {message}
              </Text>
            )}
            {loading && <Text color="yellow">Processing...</Text>}
            {inputMode === 'selectRank' && availableRanks.length > 0 && (
              <Box flexDirection="column" marginTop={1}>
                <Text color="cyan">Available ranks in your hand:</Text>
                {availableRanks.map((rank, index) => {
                  const grouped = groupCardsByRank(
                    gameState.playerHands[gameState.currentTurn === 1 ? 'player1' : 'player2']
                  );
                  const count = grouped.get(rank)?.length || 0;
                  return (
                    <Text key={rank} color={index === rankSelectionIndex ? 'green' : 'white'}>
                      {index === rankSelectionIndex ? '→ ' : '  '}
                      {index + 1}. {getRankName(rank)} ({count} card{count > 1 ? 's' : ''})
                    </Text>
                  );
                })}
                <Box marginTop={1} />
                <Text color="gray">↑/↓: Navigate | Enter: Select | Esc: Cancel</Text>
              </Box>
            )}
            {inputMode === 'confirmAsk' && selectedRank !== null && (
              <Box flexDirection="column" marginTop={1}>
                <Text color="cyan">
                  Ask Player {gameState.currentTurn === 1 ? 2 : 1} for {getRankName(selectedRank)}s?
                </Text>
                <Box marginTop={1} />
                <Text color="gray">Enter: Confirm | Esc: Cancel</Text>
              </Box>
            )}
          </Box>
        </Box>
      </Box>
      
      {/* Right side: Ledger State */}
      {displayLedgerState()}
    </Box>
  );
}
