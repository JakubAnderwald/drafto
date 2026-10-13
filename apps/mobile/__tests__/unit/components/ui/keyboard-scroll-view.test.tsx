import React from "react";
import { KeyboardAvoidingView, Platform, ScrollView, StyleSheet, Text } from "react-native";

import { render } from "../../../helpers/test-utils";
import { KeyboardScrollView } from "@/components/ui/keyboard-scroll-view";

function renderForm() {
  return render(
    <KeyboardScrollView
      testID="screen"
      style={{ paddingTop: 47 }}
      contentContainerStyle={{ padding: 8 }}
    >
      <Text>Form</Text>
    </KeyboardScrollView>,
  );
}

describe("KeyboardScrollView", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it("on iOS lets the ScrollView make room for the keyboard, with no KeyboardAvoidingView", () => {
    jest.replaceProperty(Platform, "OS", "ios");
    const { UNSAFE_getByType, UNSAFE_queryByType, getByText } = renderForm();

    expect(UNSAFE_queryByType(KeyboardAvoidingView)).toBeNull();
    const scrollView = UNSAFE_getByType(ScrollView);
    expect(scrollView.props.automaticallyAdjustKeyboardInsets).toBe(true);
    expect(scrollView.props.keyboardShouldPersistTaps).toBe("handled");
    expect(scrollView.props.contentContainerStyle).toEqual({ padding: 8 });
    expect(getByText("Form")).toBeTruthy();
  });

  it("on iOS fills the screen and keeps the screen's own outer style", () => {
    jest.replaceProperty(Platform, "OS", "ios");
    const { getByTestId } = renderForm();

    expect(StyleSheet.flatten(getByTestId("screen").props.style)).toEqual({
      flex: 1,
      paddingTop: 47,
    });
  });

  it("on Android keeps a KeyboardAvoidingView, as the edge-to-edge window doesn't shrink", () => {
    jest.replaceProperty(Platform, "OS", "android");
    const { UNSAFE_getByType, getByTestId } = renderForm();

    expect(UNSAFE_getByType(KeyboardAvoidingView).props.behavior).toBe("height");
    expect(UNSAFE_getByType(ScrollView).props.automaticallyAdjustKeyboardInsets).toBe(false);
    expect(StyleSheet.flatten(getByTestId("screen").props.style)).toEqual({
      flex: 1,
      paddingTop: 47,
    });
  });
});
