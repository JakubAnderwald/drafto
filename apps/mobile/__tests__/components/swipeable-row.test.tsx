import React from "react";
import {
  AccessibilityInfo,
  Animated,
  PanResponder,
  Pressable,
  Text,
  type PanResponderCallbacks,
  type PanResponderGestureState,
  type GestureResponderEvent,
} from "react-native";
import * as Haptics from "expo-haptics";

import { render, fireEvent, act, waitFor } from "../helpers/test-utils";
import { swipeActionLabels, triggerSwipeAction } from "../helpers/swipe-actions";
import {
  ACTION_WIDTH,
  PEEK_DISTANCE,
  SwipeableRow,
  peekOffsets,
  resolveRelease,
  type SwipeAction,
} from "@/components/swipeable-row";

const mockedReduceMotion = jest.mocked(AccessibilityInfo.isReduceMotionEnabled);

function trashActions(onRestore = jest.fn(), onDelete = jest.fn()) {
  const left: SwipeAction[] = [
    {
      icon: "arrow-undo-outline",
      label: "Restore note",
      color: "white",
      backgroundColor: "green",
      onPress: onRestore,
    },
  ];
  const right: SwipeAction[] = [
    {
      icon: "trash-outline",
      label: "Delete note permanently",
      color: "white",
      backgroundColor: "red",
      onPress: onDelete,
    },
  ];
  return { left, right, onRestore, onDelete };
}

/** Captures the pan responder SwipeableRow builds, so a test can drive a swipe. */
function capturePanResponder() {
  const spy = jest.spyOn(PanResponder, "create");
  return () => {
    const config = spy.mock.calls[0]?.[0] as PanResponderCallbacks | undefined;
    if (!config) throw new Error("SwipeableRow built no pan responder");
    const event = {} as GestureResponderEvent;
    const gesture = (dx: number, vx = 0) => ({ dx, vx, dy: 0, vy: 0 }) as PanResponderGestureState;
    return {
      swipe(dx: number, vx = 0) {
        act(() => {
          config.onPanResponderGrant?.(event, gesture(0));
          config.onPanResponderMove?.(event, gesture(dx, vx));
          config.onPanResponderRelease?.(event, gesture(dx, vx));
        });
      },
      grant() {
        act(() => {
          config.onPanResponderGrant?.(event, gesture(0));
        });
      },
      move(dx: number) {
        act(() => {
          config.onPanResponderMove?.(event, gesture(dx));
        });
      },
      release(dx: number, vx = 0) {
        act(() => {
          config.onPanResponderRelease?.(event, gesture(dx, vx));
        });
      },
      terminate() {
        act(() => {
          config.onPanResponderTerminate?.(event, gesture(0));
        });
      },
      shouldSet(dx: number, dy: number) {
        return config.onMoveShouldSetPanResponder?.(event, {
          ...gesture(dx),
          dy,
        } as PanResponderGestureState);
      },
    };
  };
}

describe("resolveRelease", () => {
  const base = { offset: 0, vx: 0, isOpen: false, leftWidth: 72, rightWidth: 72 };

  it("opens the right-hand actions past 30% of their width", () => {
    expect(resolveRelease({ ...base, dx: -30 })).toBe(-72);
  });

  it("closes a short left drag", () => {
    expect(resolveRelease({ ...base, dx: -10 })).toBe(0);
  });

  it("opens on a fast left flick however short", () => {
    expect(resolveRelease({ ...base, dx: -5, vx: -1 })).toBe(-72);
  });

  it("closes an open row flicked back to the right", () => {
    expect(resolveRelease({ ...base, offset: -72, isOpen: true, dx: 10, vx: 1 })).toBe(0);
  });

  it("keeps an open row open after a slow nudge", () => {
    expect(resolveRelease({ ...base, offset: -72, isOpen: true, dx: 10, vx: 0 })).toBe(-72);
  });

  it("opens the left-hand actions on a right drag", () => {
    expect(resolveRelease({ ...base, dx: 40 })).toBe(72);
  });

  it("closes an open left side flicked back", () => {
    expect(resolveRelease({ ...base, offset: 72, isOpen: true, dx: -10, vx: -1 })).toBe(0);
  });

  it("closes a right drag on a row with no left actions", () => {
    expect(resolveRelease({ ...base, leftWidth: 0, dx: 60 })).toBe(0);
  });
});

describe("peekOffsets", () => {
  it("peeks the right-hand actions, then the left", () => {
    expect(peekOffsets(ACTION_WIDTH, ACTION_WIDTH)).toEqual([-PEEK_DISTANCE, PEEK_DISTANCE]);
  });

  it("peeks one side only when the row has one", () => {
    expect(peekOffsets(0, ACTION_WIDTH)).toEqual([-PEEK_DISTANCE]);
    expect(peekOffsets(ACTION_WIDTH, 0)).toEqual([PEEK_DISTANCE]);
  });

  it("has nothing to peek without actions", () => {
    expect(peekOffsets(0, 0)).toEqual([]);
  });
});

describe("SwipeableRow", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockedReduceMotion.mockResolvedValue(false);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("renders plain children", () => {
    const { getByText } = render(
      <SwipeableRow>
        <Text>Plain row</Text>
      </SwipeableRow>,
    );

    expect(getByText("Plain row")).toBeTruthy();
  });

  it("offers every action to screen readers by its label", () => {
    const { left, right } = trashActions();
    const { getByText } = render(
      <SwipeableRow leftActions={left} rightActions={right}>
        {(accessibility) => (
          <Pressable {...accessibility}>
            <Text>Row</Text>
          </Pressable>
        )}
      </SwipeableRow>,
    );

    expect(swipeActionLabels(getByText("Row"))).toEqual([
      "Restore note",
      "Delete note permanently",
    ]);
  });

  it("runs the matching action from a screen reader", () => {
    const { left, right, onRestore, onDelete } = trashActions();
    const { getByText } = render(
      <SwipeableRow leftActions={left} rightActions={right}>
        {(accessibility) => (
          <Pressable {...accessibility}>
            <Text>Row</Text>
          </Pressable>
        )}
      </SwipeableRow>,
    );

    triggerSwipeAction(getByText("Row"), "Delete note permanently");

    expect(onDelete).toHaveBeenCalledTimes(1);
    expect(onRestore).not.toHaveBeenCalled();
    expect(Haptics.impactAsync).toHaveBeenCalledWith(Haptics.ImpactFeedbackStyle.Light);
  });

  it("ignores an accessibility action it doesn't know", () => {
    const { left, right, onRestore, onDelete } = trashActions();
    const { getByText } = render(
      <SwipeableRow leftActions={left} rightActions={right}>
        {(accessibility) => (
          <Pressable {...accessibility}>
            <Text>Row</Text>
          </Pressable>
        )}
      </SwipeableRow>,
    );

    fireEvent(getByText("Row"), "accessibilityAction", { nativeEvent: { actionName: "magicTap" } });

    expect(onRestore).not.toHaveBeenCalled();
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("keeps no action buttons while the row is closed", () => {
    const { left, right } = trashActions();
    const { queryByTestId } = render(
      <SwipeableRow leftActions={left} rightActions={right}>
        <Text>Row</Text>
      </SwipeableRow>,
    );

    expect(queryByTestId("action-trash")).toBeNull();
    expect(queryByTestId("action-arrow-undo")).toBeNull();
  });

  it("only claims horizontal drags", () => {
    const panResponder = capturePanResponder();
    const { left, right } = trashActions();
    render(
      <SwipeableRow leftActions={left} rightActions={right}>
        <Text>Row</Text>
      </SwipeableRow>,
    );

    expect(panResponder().shouldSet(30, 5)).toBe(true);
    expect(panResponder().shouldSet(5, 30)).toBe(false);
  });

  it("shows labelled action buttons once swiped open, and reports the open once", () => {
    const panResponder = capturePanResponder();
    const onOpen = jest.fn();
    const { left, right, onDelete } = trashActions();
    const { getByTestId } = render(
      <SwipeableRow leftActions={left} rightActions={right} onOpen={onOpen}>
        <Text>Row</Text>
      </SwipeableRow>,
    );

    panResponder().swipe(-100);
    panResponder().swipe(-5);

    expect(onOpen).toHaveBeenCalledTimes(1);
    const trash = getByTestId("action-trash");
    expect(trash.props.accessibilityLabel).toBe("Delete note permanently");
    expect(getByTestId("action-arrow-undo").props.accessibilityLabel).toBe("Restore note");

    fireEvent.press(trash);
    expect(onDelete).toHaveBeenCalledTimes(1);
  });

  it("removes the action buttons again once a short drag springs closed", async () => {
    const panResponder = capturePanResponder();
    const onOpen = jest.fn();
    const { left, right } = trashActions();
    const { queryByTestId } = render(
      <SwipeableRow leftActions={left} rightActions={right} onOpen={onOpen}>
        <Text>Row</Text>
      </SwipeableRow>,
    );

    panResponder().grant();
    expect(queryByTestId("action-trash")).not.toBeNull();

    panResponder().swipe(-10);

    expect(onOpen).not.toHaveBeenCalled();
    await waitFor(() => expect(queryByTestId("action-trash")).toBeNull());
  });

  it("settles closed when the list takes the gesture", async () => {
    const panResponder = capturePanResponder();
    const { left, right } = trashActions();
    const { queryByTestId } = render(
      <SwipeableRow leftActions={left} rightActions={right}>
        <Text>Row</Text>
      </SwipeableRow>,
    );

    panResponder().grant();
    panResponder().terminate();

    await waitFor(() => expect(queryByTestId("action-trash")).toBeNull());
  });

  it("stays open when the list takes a gesture on an open row", () => {
    const panResponder = capturePanResponder();
    const { left, right } = trashActions();
    const { getByTestId } = render(
      <SwipeableRow leftActions={left} rightActions={right}>
        <Text>Row</Text>
      </SwipeableRow>,
    );

    panResponder().swipe(-100);
    panResponder().grant();
    panResponder().terminate();

    expect(getByTestId("action-trash")).toBeTruthy();
  });

  it("buzzes and reports only the user's open, not the re-settle after the list takes over", () => {
    const panResponder = capturePanResponder();
    const onOpen = jest.fn();
    const { left, right } = trashActions();
    render(
      <SwipeableRow leftActions={left} rightActions={right} onOpen={onOpen}>
        <Text>Row</Text>
      </SwipeableRow>,
    );

    panResponder().swipe(-100);
    expect(Haptics.impactAsync).toHaveBeenCalledTimes(1);
    expect(Haptics.impactAsync).toHaveBeenCalledWith(Haptics.ImpactFeedbackStyle.Medium);

    panResponder().grant();
    panResponder().terminate();

    expect(Haptics.impactAsync).toHaveBeenCalledTimes(1);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  describe("peek", () => {
    function fakeSequence() {
      let finish: ((result: { finished: boolean }) => void) | undefined;
      const stop = jest.fn(() => finish?.({ finished: false }));
      const sequence = jest.spyOn(Animated, "sequence").mockImplementation(
        () =>
          ({
            start: (callback?: (result: { finished: boolean }) => void) => {
              finish = callback;
            },
            stop,
            reset: jest.fn(),
          }) as unknown as Animated.CompositeAnimation,
      );
      return { sequence, stop, finish: () => act(() => finish?.({ finished: true })) };
    }

    it("slides the row once to each side, then reports the end", async () => {
      const timing = jest.spyOn(Animated, "timing");
      const { sequence, finish } = fakeSequence();
      const onPeekEnd = jest.fn();
      const { left, right } = trashActions();
      const { getByTestId, queryByTestId } = render(
        <SwipeableRow leftActions={left} rightActions={right} peek onPeekEnd={onPeekEnd}>
          <Text>Row</Text>
        </SwipeableRow>,
      );

      await waitFor(() => expect(sequence).toHaveBeenCalledTimes(1));
      // Out to the right-hand actions and back, then out to the left-hand ones and back.
      expect(timing.mock.calls.map(([, config]) => config.toValue)).toEqual([
        -PEEK_DISTANCE,
        0,
        PEEK_DISTANCE,
        0,
      ]);
      // The buttons are there to be seen while the row slides.
      expect(getByTestId("action-trash")).toBeTruthy();

      finish();

      expect(onPeekEnd).toHaveBeenCalledTimes(1);
      expect(queryByTestId("action-trash")).toBeNull();
    });

    it("never replays on a re-render", async () => {
      const { sequence } = fakeSequence();
      const { left, right } = trashActions();
      const { rerender } = render(
        <SwipeableRow leftActions={left} rightActions={right} peek>
          <Text>Row</Text>
        </SwipeableRow>,
      );
      await waitFor(() => expect(sequence).toHaveBeenCalledTimes(1));

      rerender(
        <SwipeableRow leftActions={left} rightActions={right} peek={false}>
          <Text>Row</Text>
        </SwipeableRow>,
      );
      rerender(
        <SwipeableRow leftActions={left} rightActions={right} peek>
          <Text>Row</Text>
        </SwipeableRow>,
      );

      await act(async () => {});
      expect(sequence).toHaveBeenCalledTimes(1);
    });

    it("is skipped when Reduce Motion is on", async () => {
      mockedReduceMotion.mockResolvedValue(true);
      const { sequence } = fakeSequence();
      const onPeekEnd = jest.fn();
      const { left, right } = trashActions();
      render(
        <SwipeableRow leftActions={left} rightActions={right} peek onPeekEnd={onPeekEnd}>
          <Text>Row</Text>
        </SwipeableRow>,
      );

      await waitFor(() => expect(onPeekEnd).toHaveBeenCalledTimes(1));
      expect(sequence).not.toHaveBeenCalled();
    });

    it("is skipped, with a warning, when Reduce Motion can't be read", async () => {
      mockedReduceMotion.mockRejectedValue(new Error("no bridge"));
      const warn = jest.spyOn(console, "warn").mockImplementation(() => {});
      const { sequence } = fakeSequence();
      const onPeekEnd = jest.fn();
      const { left, right } = trashActions();
      render(
        <SwipeableRow leftActions={left} rightActions={right} peek onPeekEnd={onPeekEnd}>
          <Text>Row</Text>
        </SwipeableRow>,
      );

      await waitFor(() => expect(onPeekEnd).toHaveBeenCalledTimes(1));
      expect(sequence).not.toHaveBeenCalled();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining("Reduce Motion"),
        expect.any(Error),
      );
    });

    it("does nothing for a row without actions", async () => {
      const { sequence } = fakeSequence();
      render(
        <SwipeableRow peek>
          <Text>Row</Text>
        </SwipeableRow>,
      );

      await act(async () => {});
      expect(mockedReduceMotion).not.toHaveBeenCalled();
      expect(sequence).not.toHaveBeenCalled();
    });

    it("gives way to the user's own swipe", async () => {
      const panResponder = capturePanResponder();
      const { sequence, stop } = fakeSequence();
      const onPeekEnd = jest.fn();
      const { left, right } = trashActions();
      const { getByTestId } = render(
        <SwipeableRow leftActions={left} rightActions={right} peek onPeekEnd={onPeekEnd}>
          <Text>Row</Text>
        </SwipeableRow>,
      );
      await waitFor(() => expect(sequence).toHaveBeenCalledTimes(1));

      panResponder().swipe(-100);

      expect(stop).toHaveBeenCalled();
      expect(onPeekEnd).toHaveBeenCalledTimes(1);
      // The swipe opened the row, so its buttons stay.
      expect(getByTestId("action-trash")).toBeTruthy();
    });

    it("picks a drag up from where the peek left the row", async () => {
      const panResponder = capturePanResponder();
      const { sequence, stop } = fakeSequence();
      // The native driver reports the peek's position when the animation stops.
      jest
        .spyOn(Animated.Value.prototype, "stopAnimation")
        .mockImplementation((callback?: (value: number) => void) => callback?.(-40));
      const setValue = jest.spyOn(Animated.Value.prototype, "setValue");
      const onOpen = jest.fn();
      const onPeekEnd = jest.fn();
      const { left, right } = trashActions();
      render(
        <SwipeableRow
          leftActions={left}
          rightActions={right}
          peek
          onPeekEnd={onPeekEnd}
          onOpen={onOpen}
        >
          <Text>Row</Text>
        </SwipeableRow>,
      );
      await waitFor(() => expect(sequence).toHaveBeenCalledTimes(1));

      panResponder().grant();
      panResponder().move(30);

      expect(stop).toHaveBeenCalled();
      expect(onPeekEnd).toHaveBeenCalledTimes(1);
      // -40 + 30, not 0 + 30: no jump, and no left-hand actions half open.
      expect(setValue).toHaveBeenLastCalledWith(-10);

      panResponder().release(30);

      // Ten points left of rest is a short drag: the row closes.
      expect(onOpen).not.toHaveBeenCalled();
    });

    it("stops and settles the row when the peek is called off mid-slide", async () => {
      const spring = jest.spyOn(Animated, "spring");
      const { sequence, stop } = fakeSequence();
      const onPeekEnd = jest.fn();
      const { left, right } = trashActions();
      const { rerender, queryByTestId } = render(
        <SwipeableRow leftActions={left} rightActions={right} peek onPeekEnd={onPeekEnd}>
          <Text>Row</Text>
        </SwipeableRow>,
      );
      await waitFor(() => expect(sequence).toHaveBeenCalledTimes(1));
      expect(queryByTestId("action-trash")).not.toBeNull();

      rerender(
        <SwipeableRow leftActions={left} rightActions={right} peek={false} onPeekEnd={onPeekEnd}>
          <Text>Row</Text>
        </SwipeableRow>,
      );

      expect(stop).toHaveBeenCalledTimes(1);
      expect(spring).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ toValue: 0 }),
      );
      expect(onPeekEnd).not.toHaveBeenCalled();
      await waitFor(() => expect(queryByTestId("action-trash")).toBeNull());
    });

    it("doesn't start when the peek is called off during the Reduce Motion lookup", async () => {
      let answer!: (reduceMotion: boolean) => void;
      mockedReduceMotion.mockReturnValueOnce(
        new Promise((resolve) => {
          answer = resolve;
        }),
      );
      const { sequence } = fakeSequence();
      const onPeekEnd = jest.fn();
      const { left, right } = trashActions();
      const { rerender } = render(
        <SwipeableRow leftActions={left} rightActions={right} peek onPeekEnd={onPeekEnd}>
          <Text>Row</Text>
        </SwipeableRow>,
      );

      rerender(
        <SwipeableRow leftActions={left} rightActions={right} peek={false} onPeekEnd={onPeekEnd}>
          <Text>Row</Text>
        </SwipeableRow>,
      );
      await act(async () => answer(false));

      expect(sequence).not.toHaveBeenCalled();
      expect(onPeekEnd).not.toHaveBeenCalled();

      // Called back on, it still gets its one slide.
      rerender(
        <SwipeableRow leftActions={left} rightActions={right} peek onPeekEnd={onPeekEnd}>
          <Text>Row</Text>
        </SwipeableRow>,
      );
      await waitFor(() => expect(sequence).toHaveBeenCalledTimes(1));
    });

    it("stops when the row unmounts mid-peek", async () => {
      const { sequence, stop } = fakeSequence();
      const { left, right } = trashActions();
      const { unmount } = render(
        <SwipeableRow leftActions={left} rightActions={right} peek>
          <Text>Row</Text>
        </SwipeableRow>,
      );
      await waitFor(() => expect(sequence).toHaveBeenCalledTimes(1));

      unmount();

      expect(stop).toHaveBeenCalled();
    });
  });
});
