import { ActivityIndicator, View, StyleSheet } from "react-native";
import { NavigationContainer } from "@react-navigation/native";
import { createNativeStackNavigator } from "@react-navigation/native-stack";

import { useAuth } from "@/providers/auth-provider";
import { useTheme } from "@/providers/theme-provider";
import { colors } from "@/theme/tokens";
import { LoginScreen } from "@/screens/login";
import { SignupScreen } from "@/screens/signup";
import { WaitingForApprovalScreen } from "@/screens/waiting-for-approval";
import { MainScreen } from "@/screens/main";

export type AuthStackParamList = {
  Login: undefined;
  Signup: undefined;
  WaitingForApproval: undefined;
};

export type AppStackParamList = {
  Main: undefined;
};

const AuthStack = createNativeStackNavigator<AuthStackParamList>();
const AppStack = createNativeStackNavigator<AppStackParamList>();

function AppNavigator() {
  const { semantic } = useTheme();

  return (
    <AppStack.Navigator
      screenOptions={{
        headerStyle: { backgroundColor: semantic.bg },
        headerTintColor: semantic.fg,
        contentStyle: { backgroundColor: semantic.bg },
      }}
    >
      <AppStack.Screen name="Main" component={MainScreen} options={{ headerShown: false }} />
    </AppStack.Navigator>
  );
}

export function RootNavigator() {
  const { user, isApproved, isLoading, isCheckingApproval } = useAuth();
  const { semantic } = useTheme();

  if (isLoading || isCheckingApproval) {
    return (
      <View style={[styles.loadingContainer, { backgroundColor: semantic.bg }]}>
        <ActivityIndicator size="large" color={colors.primary[600]} />
      </View>
    );
  }

  // When user is logged in but not approved, show WaitingForApproval as initial route
  const authInitialRoute = user && !isApproved ? "WaitingForApproval" : "Login";

  return (
    <NavigationContainer>
      {user && isApproved ? (
        <AppNavigator />
      ) : (
        <AuthStack.Navigator
          initialRouteName={authInitialRoute}
          screenOptions={{
            headerStyle: { backgroundColor: semantic.bg },
            headerTintColor: semantic.fg,
            contentStyle: { backgroundColor: semantic.bg },
          }}
        >
          <AuthStack.Screen name="Login" component={LoginScreen} options={{ title: "Log In" }} />
          <AuthStack.Screen name="Signup" component={SignupScreen} options={{ title: "Sign Up" }} />
          <AuthStack.Screen
            name="WaitingForApproval"
            component={WaitingForApprovalScreen}
            options={{
              title: "Awaiting Approval",
              headerBackVisible: false,
            }}
          />
        </AuthStack.Navigator>
      )}
    </NavigationContainer>
  );
}

const styles = StyleSheet.create({
  loadingContainer: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
  },
});
