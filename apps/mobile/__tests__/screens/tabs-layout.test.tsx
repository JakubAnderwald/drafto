import React from "react";

import { render } from "../helpers/test-utils";

const mockTabsProps = jest.fn();
jest.mock("expo-router", () => ({
  useRouter: () => ({ push: jest.fn() }),
  Tabs: Object.assign(
    (props: { children: React.ReactNode }) => {
      mockTabsProps(props);
      return props.children;
    },
    { Screen: () => null },
  ),
}));

import TabsLayout from "../../app/(tabs)/_layout";
import { offlineScreenLayout } from "@/components/navigation/offline-screen-layout";

describe("TabsLayout", () => {
  it("draws each tab's offline banner below its header, clear of the search button", () => {
    render(<TabsLayout />);

    expect(mockTabsProps).toHaveBeenCalledWith(
      expect.objectContaining({ screenLayout: offlineScreenLayout }),
    );
  });
});
